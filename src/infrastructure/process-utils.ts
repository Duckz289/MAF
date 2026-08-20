import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
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
  },
): Promise<ProcessResult> => {
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    shell: options.shell ?? false,
    windowsHide: true,
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
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let timedOut = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  // SIGTERM alone does not bound execution: on Windows it neither kills the child's own children
  // nor guarantees the stdio pipes close (a grandchild holding them keeps "close" from firing).
  // Escalate to a forced tree kill after the grace period — taskkill /T on Windows, SIGKILL
  // elsewhere — so a wedged subprocess can never hang the quality gate open-endedly.
  const killTree = (): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      child.kill("SIGKILL");
    }
  };
  const terminate = (): void => {
    child.kill("SIGTERM");
    killTimer = setTimeout(killTree, killGraceMs);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs ?? 120_000);
  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const exitCode = await new Promise<number>((resolve, reject) => {
    let settled = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      if (exitTimer !== undefined) clearTimeout(exitTimer);
      resolve(code);
    };
    child.on("error", reject);
    child.on("close", (code) => settle(code ?? 1));
    child.on("exit", (code) => {
      // Orphaned grandchildren can hold the stdio pipes open after the direct child exits; bound
      // the wait so "close" never blocks resolution indefinitely.
      exitTimer = setTimeout(() => settle(code ?? 1), killGraceMs);
    });
  }).finally(() => {
    clearTimeout(timeout);
    if (killTimer !== undefined) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
  });
  if (timedOut) stderr += "\nProcess timed out";
  else if (aborted) stderr += "\nProcess aborted";
  return { exitCode, stdout, stderr, durationMs: performance.now() - started };
};
