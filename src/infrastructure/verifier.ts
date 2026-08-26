import { existsSync } from "node:fs";
import path from "node:path";
import type { Sandbox, SandboxDiff, VerifierPort } from "../domain/ports";
import type { Run, Task, Verification, VerifierExecutionEvidence } from "../domain/types";
import { runProcess, type ProcessResult } from "./process-utils";

const shellCommand = (): { command: string; prefix: string[] } =>
  process.platform === "win32"
    ? { command: "powershell", prefix: ["-NoProfile", "-NonInteractive", "-Command"] }
    : { command: "/bin/sh", prefix: ["-lc"] };

/**
 * Command-NAME resolution failure detection at the boundary that knows the shell. These are the
 * shells' own machine-readable error records, not prose: PowerShell emits the error type
 * `CommandNotFoundException` (in both CategoryInfo and FullyQualifiedErrorId) with exit code 1 —
 * no generic text pattern reliably matches it — while POSIX shells use exit 127 and the
 * "command not found" string. A resolution failure of the verification command's name means the
 * VERIFIER TOOLCHAIN is unavailable: the candidate's code cannot make a command name unresolvable.
 */
const commandResolutionFailed = (
  shellCommandName: string,
  exitCode: number,
  output: string,
): boolean => {
  const lower = output.toLowerCase();
  if (lower.includes("commandnotfoundexception")) return true;
  if (/is not recognized as the name of a cmdlet/.test(lower)) return true;
  if (shellCommandName === "/bin/sh") {
    return exitCode === 127 || lower.includes("command not found");
  }
  return exitCode === 127 || exitCode === 9009;
};

export class CommandVerifier implements VerifierPort {
  private readonly cancelled = new Set<string>();

  async verify(run: Run, task: Task, sandbox: Sandbox, _diff: SandboxDiff): Promise<Verification> {
    const startedAt = new Date().toISOString();
    let exitCode = 0;
    let output = "";
    let execution: VerifierExecutionEvidence | undefined;

    if (this.cancelled.has(run.id)) {
      return this.result(run, "CANCELLED", 1, "Verification cancelled", startedAt, undefined);
    }

    if (!task.verification.command && !task.verification.expectedFile) {
      return this.result(
        run,
        "NOT_CHECKED",
        1,
        "Verification was not configured; captured candidate material is not proof of correctness",
        startedAt,
        undefined,
      );
    }

    if (task.verification.expectedFile) {
      const target = path.resolve(sandbox.path, task.verification.expectedFile);
      if (!target.startsWith(`${path.resolve(sandbox.path)}${path.sep}`)) {
        return this.result(
          run,
          "FAILED",
          1,
          "Expected file escapes the sandbox",
          startedAt,
          undefined,
        );
      }
      const exists = existsSync(target);
      exitCode = exists ? 0 : 1;
      output += exists
        ? `Found ${task.verification.expectedFile}`
        : `Missing ${task.verification.expectedFile}`;
    }

    if (task.verification.command) {
      const shell = shellCommand();
      const timeoutMs = task.verification.timeoutMs ?? 120_000;
      execution = { shellSpawned: true, commandResolution: "RESOLVED", timeoutMs };
      let result: ProcessResult | undefined;
      try {
        result = await runProcess(shell.command, [...shell.prefix, task.verification.command], {
          cwd: sandbox.path,
          timeoutMs,
        });
      } catch {
        // Spawn error (ENOENT etc.) — the verifier's shell process itself never started.
        result = undefined;
        execution = {
          shellSpawned: false,
          commandResolution: "SHELL_UNAVAILABLE",
          termination: "NOT_STARTED",
          timeoutMs,
        };
      }
      if (result !== undefined) {
        exitCode = Math.max(exitCode, result.exitCode);
        const combined = `${result.stdout}${result.stderr}`;
        output += `${output ? "\n" : ""}${combined}`.trimEnd();
        // How the process ENDED is known here and nowhere downstream: the timer that killed it is
        // this boundary's own. Recording it structurally keeps attribution off output prose, which
        // the candidate's own program controls.
        execution = {
          shellSpawned: true,
          commandResolution:
            result.exitCode !== 0 &&
            commandResolutionFailed(shell.command, result.exitCode, combined)
              ? "COMMAND_NOT_FOUND"
              : "RESOLVED",
          termination: result.timedOut
            ? "TIMED_OUT"
            : result.signal !== null
              ? "SIGNALLED"
              : "COMPLETED",
          ...(result.signal !== null ? { terminatingSignal: result.signal } : {}),
          durationMs: Math.round(result.durationMs),
          timeoutMs,
        };
      } else {
        exitCode = Math.max(exitCode, 1);
        output += `${output ? "\n" : ""}verifier shell "${shell.command}" could not be spawned`;
      }
    }

    return this.result(
      run,
      exitCode === 0 ? "VERIFIED" : "QUARANTINED",
      exitCode,
      output,
      startedAt,
      execution,
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
    execution: VerifierExecutionEvidence | undefined,
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
      ...(execution !== undefined ? { execution } : {}),
    };
  }
}
