import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PerformanceMeasurement, PerformanceMetricMeasurement } from "../domain/performance";
import type { PerformanceMeasureInput, PerformanceVerifierPort } from "../domain/ports";
import { runProcess } from "./process-utils";

const shellCommand = (): { command: string; prefix: string[] } =>
  process.platform === "win32"
    ? { command: "powershell", prefix: ["-NoProfile", "-NonInteractive", "-Command"] }
    : { command: "/bin/sh", prefix: ["-lc"] };

const median = (values: number[]): number => {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? Number.NaN);
};

const numericOutput = (stdout: string): number | undefined => {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return undefined;
  const direct = Number(line);
  if (Number.isFinite(direct)) return direct;
  try {
    const parsed = JSON.parse(line) as { value?: unknown };
    return typeof parsed.value === "number" && Number.isFinite(parsed.value)
      ? parsed.value
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Runs the same bounded command against a clean source baseline and the candidate workspace. The
 * command must print a number (or `{ "value": number }`) on its final stdout line. A dirty source
 * repository is not a trustworthy baseline and therefore produces NOT_CHECKED rather than PASS.
 */
export class CommandPerformanceVerifier implements PerformanceVerifierPort {
  async measure(input: PerformanceMeasureInput): Promise<PerformanceMeasurement> {
    const spec = input.task.performance;
    const notChecked = (evidence: string): PerformanceMeasurement => ({
      state: "NOT_CHECKED",
      candidateId: input.candidateId,
      diffDigest: input.diffDigest,
      metrics: [],
      evidence: [evidence],
    });
    if (!spec) return notChecked("no performance measurement specification was configured");
    const status = await runProcess("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: input.task.repositoryPath,
      timeoutMs: 10_000,
    });
    if (status.exitCode !== 0 || status.stdout.trim() !== "") {
      return notChecked("source repository is not a clean, trustworthy performance baseline");
    }
    const resolved = await runProcess("git", ["rev-parse", input.task.revision], {
      cwd: input.task.repositoryPath,
      timeoutMs: 10_000,
    });
    const candidateHead = await runProcess("git", ["rev-parse", "HEAD"], {
      cwd: input.sandbox.path,
      timeoutMs: 10_000,
    });
    if (
      resolved.exitCode !== 0 ||
      candidateHead.exitCode !== 0 ||
      resolved.stdout.trim() !== candidateHead.stdout.trim()
    ) {
      return notChecked("candidate HEAD does not match the requested baseline revision");
    }

    const samples = Math.min(10, Math.max(1, spec.samples ?? 3));
    const runSamples = async (cwd: string): Promise<number[] | undefined> => {
      const values: number[] = [];
      const shell = shellCommand();
      for (let sample = 0; sample < samples; sample += 1) {
        const result = await runProcess(shell.command, [...shell.prefix, spec.command], {
          cwd,
          timeoutMs: spec.timeoutMs ?? 120_000,
        });
        const value = numericOutput(result.stdout);
        if (result.exitCode !== 0 || value === undefined) return undefined;
        values.push(value);
      }
      return values;
    };
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "maf-performance-baseline-"));
    const baselinePath = path.join(temporaryRoot, "worktree");
    let baseline: number[] | undefined;
    try {
      const created = await runProcess(
        "git",
        ["worktree", "add", "--detach", baselinePath, resolved.stdout.trim()],
        { cwd: input.task.repositoryPath, timeoutMs: 30_000 },
      );
      if (created.exitCode !== 0)
        return notChecked("ephemeral baseline worktree could not be created");
      baseline = await runSamples(baselinePath);
    } finally {
      await runProcess("git", ["worktree", "remove", "--force", baselinePath], {
        cwd: input.task.repositoryPath,
        timeoutMs: 30_000,
      }).catch(() => undefined);
      // `temporaryRoot` is the exact directory returned by mkdtemp, never a computed broad path.
      // Cleanup failures (e.g. Windows file locks) must not invalidate a valid measurement.
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!baseline) return notChecked("baseline performance command failed or returned no number");
    const candidate = await runSamples(input.sandbox.path);
    if (!candidate) return notChecked("candidate performance command failed or returned no number");

    const metric: PerformanceMetricMeasurement = {
      name: spec.metric,
      unit: spec.unit ?? "unknown",
      baseline: median(baseline),
      candidate: median(candidate),
      lowerIsBetter: spec.lowerIsBetter ?? true,
    };
    return {
      state: "MEASURED",
      candidateId: input.candidateId,
      diffDigest: input.diffDigest,
      metrics: [metric],
      evidence: [
        `${samples} baseline and ${samples} candidate sample(s) measured with the configured trusted command`,
        `baseline revision ${resolved.stdout.trim()}`,
      ],
    };
  }
}
