import { describe, expect, it } from "vitest";
import type { Run, Task } from "../src/domain/types";
import { CommandVerifier } from "../src/infrastructure/verifier";

const run = {
  id: "run-session-11",
  taskId: "task-session-11",
  state: "RUNNING",
  executionMode: "GUIDED",
  desiredMode: "GUIDED",
  effectiveMode: "GUIDED",
  verificationState: "VERIFYING",
  agent: "fixture",
  model: "fixture",
  provider: "fixture",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  changedFiles: [],
  cost: { model: 0, sandbox: 0, verification: 0, retry: 0, recovery: 0, total: 0 },
  usage: { input: 0, output: 0, cached: 0 },
  retryCount: 0,
} satisfies Run;

const task = {
  id: "task-session-11",
  prompt: "change one file",
  repositoryPath: ".",
  revision: "HEAD",
  createdAt: "2026-08-25T00:00:00.000Z",
  verification: {},
} satisfies Task;

describe("Session 11 verification specification", () => {
  it("keeps an unspecified verifier explicitly NOT_CHECKED", async () => {
    const result = await new CommandVerifier().verify(
      run,
      task,
      {
        id: run.id,
        path: process.cwd(),
        repositoryPath: process.cwd(),
        revision: "HEAD",
        baseRevision: "a".repeat(40),
      },
      { patch: "+export const changed = true;", changedFiles: ["src/changed.ts"] },
    );

    expect(result.state).toBe("NOT_CHECKED");
    expect(result.output).toMatch(/not configured|not checked/iu);
    expect(result.output).not.toMatch(/captured .*changed file|expected-file.*succeeded/iu);
  });
});
