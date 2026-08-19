import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export const runProcess = async (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; shell?: boolean },
): Promise<ProcessResult> => {
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    shell: options.shell ?? false,
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
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
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeoutMs ?? 120_000);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timeout));
  if (timedOut) stderr += "\nProcess timed out";
  return { exitCode, stdout, stderr, durationMs: performance.now() - started };
};
