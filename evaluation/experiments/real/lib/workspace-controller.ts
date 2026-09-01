// Controller-owned candidate workspace allocation for the real Native/MAF executors.
//
// Every workspace a participant executes in is created and owned here, never by the participant.
// This is what lets `BenchmarkTask.candidateWorkspaces` (src/benchmark/runner.ts) be trusted as a
// controller-observed path rather than something a participant could redirect: a path a participant
// could name is a path it could fabricate.
//
// Both arms start from byte-identical pristine fixture content (the `startingRepositorySeed`
// controlled variable). Each workspace is also git-initialized with that content staged: the real
// MAF executor's context strategy reuses `LocalRepositoryIndex` (src/infrastructure/project-brain.ts)
// unmodified, and that index shells out to `git ls-files`, so it requires a real (if minimal) git
// repository under it. The Native workspace is git-initialized identically only so the controlled
// starting state matches exactly between arms; Native's own context comes entirely from the Claude
// Code CLI's native repository search over the workspace, never from this git history.

import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CandidateWorkspace {
  arm: "NATIVE" | "MAF";
  path: string;
}

/**
 * Owns the lifecycle of every workspace created for one experiment run (one task, both arms).
 * `cleanup()` is the only thing allowed to delete a workspace; callers must not remove it directly,
 * so a workspace inspected by the independent verifier is never pulled out from under it mid-check.
 */
export class ExperimentWorkspaceController {
  private readonly created: CandidateWorkspace[] = [];

  /** Materializes one arm's workspace from the pristine fixture and stages it as a git repository. */
  async createCandidateWorkspace(arm: "NATIVE" | "MAF", pristineRepoPath: string): Promise<string> {
    const prefix = `maf-experiment-v2-${arm.toLowerCase()}-`;
    const workspace = await mkdtemp(path.join(tmpdir(), prefix));
    await cp(pristineRepoPath, workspace, { recursive: true });
    await this.gitInit(workspace);
    this.created.push({ arm, path: workspace });
    return workspace;
  }

  listWorkspaces(): readonly CandidateWorkspace[] {
    return [...this.created];
  }

  /** Removes every workspace this controller created. Safe to call more than once. */
  async cleanup(): Promise<void> {
    for (const workspace of this.created.splice(0)) {
      await rm(workspace.path, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => undefined,
      );
    }
  }

  private async gitInit(workspace: string): Promise<void> {
    const run = (args: string[]) => execFileAsync("git", args, { cwd: workspace });
    await run(["init", "--quiet"]);
    await run(["config", "user.email", "experiment-controller@local.invalid"]);
    await run(["config", "user.name", "MAF Experiment Controller"]);
    await run(["add", "-A"]);
    await run(["commit", "--quiet", "--no-verify", "-m", "controller: pristine fixture seed"]);
  }
}
