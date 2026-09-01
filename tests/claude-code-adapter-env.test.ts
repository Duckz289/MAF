import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/infrastructure/claude-code-adapter";
import { checkEnvironmentRouting } from "../evaluation/experiments/real/lib/preflight-gate";
import { emptyCost, emptyUsage, type Run, type Task } from "../src/domain/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const envProbeCliPath = path.join(here, "fixtures", "fake-claude-env-probe.mjs");

const cleanup: string[] = [];
const restore: Array<() => void> = [];

afterEach(async () => {
  for (const file of cleanup.splice(0)) await rm(file, { force: true });
  for (const undo of restore.splice(0)) undo();
});

const setEnv = (key: string, value: string) => {
  const previous = process.env[key];
  process.env[key] = value;
  restore.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
};

describe("participant environment isolation (routing contamination gate)", () => {
  it("never forwards ANTHROPIC_* routing or credentials to the participant process", async () => {
    // Simulate exactly the contamination risk observed in this environment: the CONTROLLER's own
    // process carries provider routing and a token belonging to whatever harness runs it. None of
    // it may reach the participant, which must use the Claude Code CLI's own native auth.
    setEnv("ANTHROPIC_BASE_URL", "https://not-the-real-endpoint.invalid");
    setEnv("ANTHROPIC_MODEL", "some-other-provider-model");
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-should-never-be-forwarded-to-the-child");

    const token = `env-${crypto.randomUUID()}`;
    const logPath = path.join(process.env.TEMP ?? tmpdir(), `fake-cli-env-${token}.log`);
    cleanup.push(logPath);

    const adapter = new ClaudeCodeAdapter({ command: envProbeCliPath });
    const run: Run = {
      id: token,
      taskId: "env-isolation-test",
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
    };
    const task: Task = {
      id: "env-isolation-test",
      prompt: "irrelevant",
      repositoryPath: process.cwd(),
      revision: "HEAD",
      createdAt: new Date().toISOString(),
      verification: {},
    };
    const session = await adapter.start({
      run,
      task,
      workspacePath: process.cwd(),
      initialContext: "",
      credentialReferences: [],
    });
    await adapter.send(session, "do the thing");
    for await (const _event of adapter.events(session)) {
      // drain until the probe exits
    }

    const observed = JSON.parse(await readFile(logPath, "utf8")) as Record<string, string | null>;
    expect(observed.ANTHROPIC_BASE_URL ?? null).toBeNull();
    expect(observed.ANTHROPIC_MODEL ?? null).toBeNull();
    expect(observed.ANTHROPIC_AUTH_TOKEN ?? null).toBeNull();
    // The allowlisted variables the CLI legitimately needs DO arrive.
    expect(observed.PATH).toBeTruthy();
    expect(observed.HARNESS_RUN_ID).toBe(token);
  }, 15_000);
});

describe("checkEnvironmentRouting", () => {
  it("reports controller-side routing as present but never forwarded", () => {
    setEnv("ANTHROPIC_BASE_URL", "https://example.invalid");
    setEnv("ANTHROPIC_MODEL", "other-model");
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-secret");

    const gate = checkEnvironmentRouting();
    expect(gate.externalBaseUrlOverridePresent).toBe(true);
    expect(gate.externalModelOverridePresent).toBe(true);
    expect(gate.externalAuthTokenPresent).toBe(true);
    expect(gate.externalBaseUrlOverrideForwarded).toBe(false);
    expect(gate.externalModelOverrideForwarded).toBe(false);
    expect(gate.externalAuthTokenForwarded).toBe(false);
    // Presence is reported; the values themselves never are.
    expect(JSON.stringify(gate)).not.toContain("sk-secret");
    expect(JSON.stringify(gate)).not.toContain("other-model");
  });

  it("reports a clean environment when no routing overrides exist", () => {
    const gate = checkEnvironmentRouting({} as NodeJS.ProcessEnv);
    expect(gate.externalModelOverridePresent).toBe(false);
    expect(gate.detail).toMatch(/no ANTHROPIC_\* routing/i);
  });
});
