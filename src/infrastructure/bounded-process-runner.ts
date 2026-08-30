import { runProcess } from "./process-utils";

export interface BoundedProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BoundedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
}

/**
 * Local shell-free runner for optional scanner adapters. Output is bounded before accumulation;
 * spawn diagnostics are deliberately categorical so paths or credentials cannot cross adapters.
 */
export class LocalBoundedProcessRunner {
  constructor(private readonly maxOutputBytes = 8 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error("maxOutputBytes must be a positive safe integer");
    }
  }

  async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    try {
      const result = await runProcess(request.command, request.args, {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        killProcessTree: true,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        outputLimitExceeded: result.outputLimitExceeded === true,
      };
    } catch {
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
        aborted: request.signal?.aborted === true,
        outputLimitExceeded: false,
        spawnError: "process could not be started",
      };
    }
  }
}
