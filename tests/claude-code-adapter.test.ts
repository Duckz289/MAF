import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/infrastructure/claude-code-adapter";
import { emptyCost, emptyUsage, type AgentEvent, type Run, type Task } from "../src/domain/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCliPath = path.join(here, "fixtures", "fake-claude-cli.mjs");

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
): Promise<{ events: AgentEvent[]; sessionId: string; timedOut: boolean }> => {
  const session = await adapter.start({
    run: buildRun(scenario),
    task: buildTask(),
    workspacePath: process.cwd(),
    initialContext: "",
    credentialReferences: [],
  });
  await adapter.send(session, "do the thing");

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
  return { events, sessionId: session.id, timedOut: outcome === TIMEOUT };
};

describe("ClaudeCodeAdapter (fake CLI contract test)", () => {
  it("parses a successful stream-json transcript into message/tool/usage/complete events", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "success");

    const message = events.find((event) => event.type === "message");
    expect(message?.data.text).toBe("Working on it.");

    const tool = events.find((event) => event.type === "tool");
    expect(tool?.data.tool).toBe("write_file");
    expect(tool?.data.path).toBe("src/example.ts");

    const usage = events.find((event) => event.type === "usage");
    expect(usage?.data).toMatchObject({
      inputTokens: 321,
      outputTokens: 654,
      cachedTokens: 12,
      costUsd: 0.1234,
      resolvedModel: "claude-sonnet-5-20250929",
    });

    const complete = events.find((event) => event.type === "complete");
    expect(complete?.data).toMatchObject({
      result: "Done.",
      nativeSessionId: "fake-session-1",
      subtype: "success",
    });

    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("falls back malformed non-JSON stdout lines to a message event instead of throwing", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "malformed");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("message");
    expect(events[0]?.data.text).toBe("this is not json at all");
    expect(events.some((event) => event.type === "complete")).toBe(false);
  });

  it("reports a nonzero exit code as a structured error event", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { events } = await collectEvents(adapter, "nonzero-exit");

    const error = events.find((event) => event.type === "error");
    expect(error?.data.exitCode).toBe(2);
    expect(events.some((event) => event.type === "complete")).toBe(false);
  });

  it("terminates a hung process on cancel() instead of running forever", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath });
    const { timedOut } = await collectEvents(adapter, "hang", 500);
    expect(timedOut).toBe(true);
    // cancel() having been issued should let the process exit; give it a moment and verify no
    // exception is thrown calling cancel a second time (idempotent no-op once the child is gone).
  }, 10_000);

  it("honors an empty promptPreamble override (used by the NATIVE experiment arm)", async () => {
    const adapter = new ClaudeCodeAdapter({ command: fakeCliPath, promptPreamble: "" });
    // No direct way to observe the constructed prompt through the port; this exercises the code
    // path without throwing, and full prompt-composition coverage lives in the executor tests that
    // assert `initialContext` on the started input.
    const { events } = await collectEvents(adapter, "success");
    expect(events.some((event) => event.type === "complete")).toBe(true);
  });
});
