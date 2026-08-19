import { existsSync } from "node:fs";
import path from "node:path";
import type { Sandbox, SandboxDiff, VerifierPort } from "../domain/ports";
import type { Run, Task, Verification } from "../domain/types";
import { runProcess } from "./process-utils";

const shellCommand = (): { command: string; prefix: string[] } =>
  process.platform === "win32"
    ? { command: "powershell", prefix: ["-NoProfile", "-NonInteractive", "-Command"] }
    : { command: "/bin/sh", prefix: ["-lc"] };

export class CommandVerifier implements VerifierPort {
  private readonly cancelled = new Set<string>();

  async verify(run: Run, task: Task, sandbox: Sandbox, diff: SandboxDiff): Promise<Verification> {
    const startedAt = new Date().toISOString();
    let exitCode = 0;
    let output = "";

    if (this.cancelled.has(run.id)) {
      return this.result(run, "CANCELLED", 1, "Verification cancelled", startedAt);
    }

    if (task.verification.expectedFile) {
      const target = path.resolve(sandbox.path, task.verification.expectedFile);
      if (!target.startsWith(`${path.resolve(sandbox.path)}${path.sep}`)) {
        return this.result(run, "FAILED", 1, "Expected file escapes the sandbox", startedAt);
      }
      const exists = existsSync(target);
      exitCode = exists ? 0 : 1;
      output += exists
        ? `Found ${task.verification.expectedFile}`
        : `Missing ${task.verification.expectedFile}`;
    }

    if (task.verification.command) {
      const shell = shellCommand();
      const result = await runProcess(shell.command, [...shell.prefix, task.verification.command], {
        cwd: sandbox.path,
        timeoutMs: task.verification.timeoutMs ?? 120_000,
      });
      exitCode = Math.max(exitCode, result.exitCode);
      output += `${output ? "\n" : ""}${result.stdout}${result.stderr}`.trimEnd();
    }

    if (!task.verification.command && !task.verification.expectedFile) {
      exitCode = diff.changedFiles.length > 0 ? 0 : 1;
      output =
        diff.changedFiles.length > 0
          ? `Captured ${diff.changedFiles.length} changed file(s)`
          : "No changed files were captured";
    }

    return this.result(
      run,
      exitCode === 0 ? "VERIFIED" : "QUARANTINED",
      exitCode,
      output,
      startedAt,
    );
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }

  private result(
    run: Run,
    state: Verification["state"],
    exitCode: number,
    output: string,
    startedAt: string,
  ): Verification {
    return {
      id: crypto.randomUUID(),
      runId: run.id,
      type: "command",
      state,
      exitCode,
      output: output.slice(0, 100_000),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}
