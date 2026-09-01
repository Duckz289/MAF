import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/infrastructure/claude-code-adapter";
import { emptyCost, emptyUsage, type AgentEvent, type Run, type Task } from "../src/domain/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCliPath = path.join(here, "fixtures", "fake-claude-cli.mjs");

/**
 * The fake CLI writes its received argv to TEMP under a token embedded in HARNESS_RUN_ID. That
 * indirection exists because ClaudeCodeAdapter forwards only a curated env allowlist and must not
 * be loosened just to make a test easier to write.
 */
const argvLogPath = (token: string) =>
  path.join(process.env.TEMP ?? tmpdir(), `fake-cli-argv-${token}.log`);

const logsToClean: string[] = [];

afterEach(async () => {
  for (const file of logsToClean.splice(0)) await rm(file, { force: true });
});

const buildRun = (scenario: string): Run => ({
  id: scenario,
  taskId: "adapter-contract-test",
  state: "RUNNING",
  executionMode: "GUIDED",
  desiredMode: "GUIDED",
  effectiveMode: "GUIDED",
  verificationState: "NOT_CHECKED",
  agent: "claude-code",
  model: "claude-sonnet-5",
  provider: "anthropic",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  changedFiles: [],
  cost: emptyCost(),
  usage: emptyUsage(),
  retryCount: 0,
});

const buildTask = (): Task => ({
  id: "adapter-contract-test",
  prompt: "irrelevant",
  repositoryPath: process.cwd(),
  revision: "HEAD",
  createdAt: new Date().toISOString(),
  verification: {},
});

const collectEvents = async (
  adapter: ClaudeCodeAdapter,
  scenario: string,
  timeoutMs = 5_000,
): Promise<{ events: AgentEvent[]; timedOut: boolean; spawnArgs: string[] | null }> => {
  const session = await adapter.start({
    run: buildRun(scenario),
    task: buildTask(),
    workspacePath: process.cwd(),
    initialContext: "",
    credentialReferences: [],
  });
  await adapter.send(session, "do the thing");
  const spawnArgs = adapter.spawnRecord(session)?.args ?? null;

  const events: AgentEvent[] = [];
  const drain = async () => {
    for await (const event of adapter.events(session)) events.push(event);
  };
  const TIMEOUT = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  const outcome = await Promise.race([drain().then(() => "DONE" as const), timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (outcome === TIMEOUT) await adapter.cancel(session);
  return { events, timedOut: outcome === TIMEOUT, spawnArgs };
};

const errorEvent = (events: AgentEvent[]) => events.find((event) => event.type === "error");
const completeEvent = (events: AgentEvent[]) => events.find((event) => event.type === "complete");

describe("ClaudeCodeAdapter (fake CLI contract test)", () => {
  it("parses a successful stream-json transcript into message/tool/usage/complete events", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "success");

    expect(events.find((event) => event.type === "message")?.data.text).toBe("Working on it.");
    expect(events.find((event) => event.type === "tool")?.data.tool).toBe("write_file");
    expect(events.find((event) => event.type === "usage")?.data).toMatchObject({
      inputTokens: 321,
      outputTokens: 654,
      cachedTokens: 12,
      costUsd: 0.1234,
      resolvedModel: "claude-sonnet-5-20250929",
    });
    expect(completeEvent(events)?.data).toMatchObject({
      result: "Done.",
      nativeSessionId: "fake-session-1",
      subtype: "success",
      isError: false,
    });
    expect(errorEvent(events)).toBeUndefined();
  });

  it("emits --effort so the protocol's controlled variable is actually sent (Finding 4)", async () => {
    const token = `effort-${crypto.randomUUID()}`;
    const logPath = argvLogPath(token);
    logsToClean.push(logPath);

    const adapter = new ClaudeCodeAdapter({
      command: fakeCliPath,
      model: "claude-sonnet-5",
      effort: "high",
      maxBudgetUsd: 8,
    });
    const { spawnArgs } = await collectEvents(adapter, `success|${token}`);

    // Proven two independent ways: the adapter's own spawn record, and what the process received.
    expect(spawnArgs).toContain("--effort");
    expect(spawnArgs?.[(spawnArgs?.indexOf("--effort") ?? -1) + 1]).toBe("high");
    const logged = JSON.parse((await readFile(logPath, "utf8")).trim()) as string[];
    expect(logged).toContain("--effort");
    expect(logged[logged.indexOf("--effort") + 1]).toBe("high");
    expect(logged[logged.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(logged[logged.indexOf("--max-budget-usd") + 1]).toBe("8");
  });

  it("omits --effort entirely when no effort is configured", async () => {
    const token = `no-effort-${crypto.randomUUID()}`;
    const logPath = argvLogPath(token);
    logsToClean.push(logPath);

    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    await collectEvents(adapter, `success|${token}`);
    const logged = JSON.parse((await readFile(logPath, "utf8")).trim()) as string[];
    expect(logged).not.toContain("--effort");
  });

  it("reports is_error on an error result instead of collapsing it into a success", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "error-result");

    expect(completeEvent(events)?.data).toMatchObject({
      subtype: "error_during_execution",
      isError: true,
    });
    expect(errorEvent(events)?.data.exitCode).toBe(1);
  });

  it("preserves BOTH a structured success result and the later nonzero exit", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "success-then-nonzero-exit");

    // The adapter reports both facts; deciding between them is session-outcome.ts's job.
    expect(completeEvent(events)?.data.subtype).toBe("success");
    expect(errorEvent(events)?.data.exitCode).toBe(1);
  });

  it("distinguishes signal termination from exit(1) (never coerces null to 1)", async () => {
    // A controller-initiated kill -- exactly what cancel() does on timeout -- reports
    // (code=null, signal=SIGTERM) on both POSIX and Windows. Before the repair this arrived
    // downstream as exitCode 1, making a killed process indistinguishable from a genuine exit(1).
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const session = await adapter.start({
      run: buildRun("hang"),
      task: buildTask(),
      workspacePath: process.cwd(),
      initialContext: "",
      credentialReferences: [],
    });
    await adapter.send(session, "do the thing");

    const events: AgentEvent[] = [];
    const drained = (async () => {
      for await (const event of adapter.events(session)) events.push(event);
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await adapter.cancel(session);
    await drained;

    const error = errorEvent(events);
    expect(error).toBeDefined();
    expect(error?.data.exitCode).toBeNull();
    expect(error?.data.terminationSignal).toBe("SIGTERM");
  }, 10_000);

  it("surfaces stderr as a structured stream event so diagnostics survive", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "auth-failure");

    const stderr = events.find((event) => event.type === "tool" && event.data.stream === "stderr");
    expect(String(stderr?.data.text)).toMatch(/authentication failed/i);
    expect(errorEvent(events)?.data.exitCode).toBe(1);
  });

  it("falls back malformed non-JSON stdout lines to a message event instead of throwing", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "malformed");

    expect(events.find((event) => event.type === "message")?.data.text).toBe(
      "this is not json at all",
    );
    expect(completeEvent(events)).toBeUndefined();
    expect(errorEvent(events)?.data.exitCode).toBe(1);
  });

  it("reports a bare nonzero exit with no structured result", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "bare-nonzero-exit");

    expect(completeEvent(events)).toBeUndefined();
    expect(errorEvent(events)?.data.exitCode).toBe(1);
  });

  it("passes a placeholder model identity through verbatim for downstream classification", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "synthetic-model");

    // The adapter reports what it saw; diagnostics.ts is what refuses to call it RESOLVED.
    expect(events.find((event) => event.type === "usage")?.data.resolvedModel).toBe("<synthetic>");
  });

  it("reports no cost at all when the CLI omitted total_cost_usd", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "success-unknown-cost");

    expect(events.find((event) => event.type === "usage")?.data.costUsd).toBeNull();
  });

  it("terminates a hung process on cancel() instead of running forever", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { timedOut } = await collectEvents(adapter, "hang", 500);
    expect(timedOut).toBe(true);
  }, 10_000);

  it("records the executable and argv it actually spawned", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const session = await adapter.start({
      run: buildRun("success"),
      task: buildTask(),
      workspacePath: process.cwd(),
      initialContext: "",
      credentialReferences: [],
    });
    await adapter.send(session, "do the thing");

    const record = adapter.spawnRecord(session);
    // A `.mjs` fake CLI is run through Node; the script path is the first argument.
    expect(record?.command).toBe(process.execPath);
    expect(record?.args[0]).toBe(fakeCliPath);
    expect(record?.args).toContain("--output-format");

    for await (const _event of adapter.events(session)) {
      // drain so the child exits and the session is released
    }
  });
});
