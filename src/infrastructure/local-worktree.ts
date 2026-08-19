import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Sandbox, SandboxDiff, SandboxProvider } from "../domain/ports";
import { runProcess } from "./process-utils";

export type SandboxRetention = "none" | "failed" | "all";

export class LocalWorktreeSandbox implements SandboxProvider {
  constructor(
    private readonly root: string,
    private readonly retention: SandboxRetention = "failed",
  ) {}

  async create(runId: string, repositoryPath: string, revision: string): Promise<Sandbox> {
    const absoluteRoot = path.resolve(this.root);
    await mkdir(absoluteRoot, { recursive: true });
    const sandboxPath = path.join(absoluteRoot, runId);
    if (path.dirname(sandboxPath) !== absoluteRoot) throw new Error("Unsafe sandbox target");
    const gitCheck = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repositoryPath,
    });
    if (gitCheck.exitCode !== 0 || gitCheck.stdout.trim() !== "true") {
      throw new Error(`Repository is not a Git worktree: ${repositoryPath}`);
    }
    const result = await runProcess("git", ["worktree", "add", "--detach", sandboxPath, revision], {
      cwd: repositoryPath,
    });
    if (result.exitCode !== 0) throw new Error(`Unable to create worktree: ${result.stderr}`);
    return { id: runId, path: sandboxPath, repositoryPath, revision };
  }

  async collectDiff(sandbox: Sandbox): Promise<SandboxDiff> {
    await runProcess("git", ["add", "-N", "."], { cwd: sandbox.path });
    const [diff, status] = await Promise.all([
      runProcess("git", ["diff", "--binary", "--no-ext-diff"], { cwd: sandbox.path }),
      runProcess("git", ["status", "--porcelain=v1"], { cwd: sandbox.path }),
    ]);
    if (diff.exitCode !== 0) throw new Error(`Unable to collect diff: ${diff.stderr}`);
    const changedFiles = status.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return { patch: diff.stdout, changedFiles: [...new Set(changedFiles)] };
  }

  async cleanup(sandbox: Sandbox, verificationState: string): Promise<void> {
    const keep =
      this.retention === "all" || (this.retention === "failed" && verificationState !== "VERIFIED");
    if (keep) return;
    const absoluteRoot = path.resolve(this.root);
    const target = path.resolve(sandbox.path);
    if (path.dirname(target) !== absoluteRoot) throw new Error("Refusing unsafe sandbox cleanup");
    await runProcess("git", ["worktree", "remove", "--force", target], {
      cwd: sandbox.repositoryPath,
    });
    await rm(target, { recursive: true, force: true });
  }

  static digest(diff: SandboxDiff): string {
    return createHash("sha256").update(diff.patch).digest("hex");
  }
}

export class DockerSandbox implements SandboxProvider {
  async create(): Promise<Sandbox> {
    throw new Error("Docker sandbox requires an injected image policy and is not enabled in V0");
  }
  async collectDiff(): Promise<SandboxDiff> {
    throw new Error("Docker sandbox is not enabled in V0");
  }
  async cleanup(): Promise<void> {}
}

export interface FutureRemoteSandbox extends SandboxProvider {}
