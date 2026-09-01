import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run, Task } from "../src/domain/types";
import { CommandVerifier } from "../src/infrastructure/verifier";

const run = {
  id: "run-expected-file",
  taskId: "task-expected-file",
  state: "RUNNING",
  executionMode: "GUIDED",
  desiredMode: "GUIDED",
  effectiveMode: "GUIDED",
  verificationState: "VERIFYING",
  agent: "fixture",
  model: "fixture",
  provider: "fixture",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  changedFiles: [],
  cost: { model: 0, sandbox: 0, verification: 0, retry: 0, recovery: 0, total: 0 },
  usage: { input: 0, output: 0, cached: 0 },
  retryCount: 0,
} satisfies Run;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const verify = async (
  expectedFile: string,
  command?: string,
  prepare?: (root: string) => Promise<void>,
) => {
  const root = await mkdtemp(path.join(tmpdir(), "maf-expected-file-"));
  roots.push(root);
  await prepare?.(root);
  const task = {
    id: run.taskId,
    prompt: "verify one file",
    repositoryPath: root,
    revision: "HEAD",
    createdAt: run.createdAt,
    verification: { expectedFile, ...(command ? { command } : {}) },
  } satisfies Task;
  return new CommandVerifier().verify(
    run,
    task,
    {
      id: run.id,
      path: root,
      repositoryPath: root,
      revision: "HEAD",
      baseRevision: "a".repeat(40),
    },
    { patch: "", changedFiles: [] },
  );
};

describe("expected-file verification boundaries", () => {
  it("passes a regular repository-relative file", async () => {
    const result = await verify("proof.txt", undefined, async (root) => {
      await writeFile(path.join(root, "proof.txt"), "ok");
    });
    expect(result.state).toBe("VERIFIED");
  });

  it.each([
    "missing.txt",
    "../outside.txt",
    "C:\\outside.txt",
    "C:relative.txt",
    "/etc/passwd",
  ])("fails safely for %s", async (expectedFile) => {
    const result = await verify(expectedFile);
    expect(result.state).not.toBe("VERIFIED");
    expect(result.exitCode).not.toBe(0);
  });

  it("does not accept a directory as a file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maf-expected-file-dir-"));
    roots.push(root);
    await mkdir(path.join(root, "proof"));
    const result = await verify("proof");
    expect(result.state).toBe("QUARANTINED");
  });

  it("keeps deterministic expected-file failure dominant over a passing command", async () => {
    const result = await verify("missing.txt", "exit 0");
    expect(result.state).toBe("QUARANTINED");
  });

  it("rejects a symlink escaping the root when symlinks are supported", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maf-expected-file-link-"));
    roots.push(root);
    const outside = await mkdtemp(path.join(tmpdir(), "maf-expected-file-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "proof.txt"), "outside");
    try {
      await symlink(path.join(outside, "proof.txt"), path.join(root, "proof.txt"));
    } catch {
      return;
    }
    const result = await verify("proof.txt");
    expect(result.state).toBe("QUARANTINED");
  });
});
