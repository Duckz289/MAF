import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /**
   * True when THIS function's own timer stopped the process. Authoritative: the harness killed it,
   * so nothing has to be inferred from output text. Downstream attribution reads this instead of
   * matching on the "Process timed out" string appended to stderr, which a candidate's own program
   * could also print.
   */
  timedOut: boolean;
  /** True when an AbortSignal (cancellation) stopped the process rather than the timeout. */
  aborted: boolean;
  /** The POSIX signal that terminated the child, when the runtime reported one. */
  signal: NodeJS.Signals | null;
  /** True when bounded capture terminated the process before untrusted output could grow further. */
  outputLimitExceeded?: boolean;
}

/** Grace period between SIGTERM and the forced tree kill. */
const killGraceMs = 5_000;

export const runProcess = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    shell?: boolean;
    /** Extra environment variables merged over the minimal inherited environment. */
    env?: Record<string, string>;
    /** Aborting kills the process tree promptly (cancellation must be respected, not awaited). */
    signal?: AbortSignal;
    /** Combined stdout/stderr byte ceiling. Omitted preserves the historical unbounded behavior. */
    maxOutputBytes?: number;
    /** Isolate and terminate the complete subprocess tree; capability runners always enable it. */
    killProcessTree?: boolean;
  },
): Promise<ProcessResult> => {
  if (
    options.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)
  ) {
    throw new Error("maxOutputBytes must be a positive safe integer");
  }
  const started = performance.now();
  const isolateProcessTree = options.killProcessTree === true;
  const child = spawn(command, args, {
    cwd: options.cwd,
    shell: options.shell ?? false,
    windowsHide: true,
    detached: isolateProcessTree && process.platform !== "win32",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SystemDrive: process.env.SystemDrive,
      // Without PATHEXT, shell children cannot resolve .cmd/.bat shims (node/npm under volta or
      // nvm), which turns every scenario command into CommandNotFoundException.
      PATHEXT: process.env.PATHEXT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...(options.env ?? {}),
    },
  });
  let stdout = "";
  let stderr = "";
  let capturedBytes = 0;
  let timedOut = false;
  let aborted = false;
  let outputLimitExceeded = false;
  let terminationRequested = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let treeKillPromise: Promise<void> | undefined;
  // SIGTERM alone does not bound execution: on Windows it neither kills the child's own children
  // nor guarantees the stdio pipes close (a grandchild holding them keeps "close" from firing).
  // Escalate to a forced tree kill after the grace period — taskkill /T on Windows, SIGKILL
  // elsewhere — so a wedged subprocess can never hang the quality gate open-endedly.
  const killTree = (): Promise<void> => {
    if (child.pid === undefined) return Promise.resolve();
    if (process.platform === "win32") {
      return new Promise((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(bound);
          resolve();
        };
        const bound = setTimeout(() => {
          killer.kill();
          finish();
        }, killGraceMs);
        bound.unref?.();
        killer.once("error", finish);
        killer.once("close", finish);
      });
    }
    if (isolateProcessTree) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    return Promise.resolve();
  };
  const terminate = (reason: "TIMEOUT" | "ABORT" | "OUTPUT_LIMIT"): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    timedOut = reason === "TIMEOUT";
    aborted = reason === "ABORT";
    outputLimitExceeded = reason === "OUTPUT_LIMIT";
    if (isolateProcessTree) {
      treeKillPromise ??= killTree();
    } else {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        void killTree();
      }, killGraceMs);
    }
  };
  const capture = (stream: "stdout" | "stderr", chunk: unknown): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const limit = options.maxOutputBytes;
    const remaining = limit === undefined ? bytes.length : Math.max(0, limit - capturedBytes);
    const retained = bytes.subarray(0, remaining);
    if (stream === "stdout") stdout += retained.toString();
    else stderr += retained.toString();
    capturedBytes += retained.length;
    if (retained.length < bytes.length) terminate("OUTPUT_LIMIT");
  };
  child.stdout.on("data", (chunk) => capture("stdout", chunk));
  child.stderr.on("data", (chunk) => capture("stderr", chunk));
  const timeout = setTimeout(() => {
    terminate("TIMEOUT");
  }, options.timeoutMs ?? 120_000);
  const onAbort = (): void => {
    terminate("ABORT");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let terminatingSignal: NodeJS.Signals | null = null;
  const exitCode = await new Promise<number>((resolve, reject) => {
    let settled = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      if (exitTimer !== undefined) clearTimeout(exitTimer);
      resolve(code);
    };
    const settleAfterTree = (code: number): void => {
      if (!treeKillPromise) {
        settle(code);
        return;
      }
      void treeKillPromise.then(
        () => settle(code),
        () => settle(code),
      );
    };
    child.on("error", reject);
    child.on("close", (code, signal) => {
      terminatingSignal ??= signal;
      settleAfterTree(code ?? 1);
    });
    child.on("exit", (code, signal) => {
      terminatingSignal ??= signal;
      if (isolateProcessTree) treeKillPromise ??= killTree();
      // Orphaned grandchildren can hold the stdio pipes open after the direct child exits; bound
      // the wait so "close" never blocks resolution indefinitely.
      exitTimer = setTimeout(() => settleAfterTree(code ?? 1), killGraceMs);
    });
  }).finally(() => {
    clearTimeout(timeout);
    if (killTimer !== undefined) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
  });
  if (options.maxOutputBytes === undefined) {
    if (timedOut) stderr += "\nProcess timed out";
    else if (aborted) stderr += "\nProcess aborted";
  } else {
    const truncateUtf8 = (value: string, maximumBytes: number): string => {
      let result = "";
      let used = 0;
      for (const character of value) {
        const bytes = Buffer.byteLength(character, "utf8");
        if (used + bytes > maximumBytes) break;
        result += character;
        used += bytes;
      }
      return result;
    };
    stdout = truncateUtf8(stdout, options.maxOutputBytes);
    const remaining = Math.max(0, options.maxOutputBytes - Buffer.byteLength(stdout, "utf8"));
    stderr = truncateUtf8(stderr, remaining);
  }
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: performance.now() - started,
    timedOut,
    aborted,
    signal: terminatingSignal,
    outputLimitExceeded,
  };
};
