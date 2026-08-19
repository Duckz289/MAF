import type { ExecutionMode, RuntimeSignalSnapshot } from "../domain/types";

export type BenchmarkStrategy = "NATIVE" | "MAF_ADAPTIVE";
export type BenchmarkVerificationResult = "VERIFIED" | "QUARANTINED" | "FAILED";

export interface BenchmarkTask {
  id: string;
  prompt: string;
  expectedVerification: string;
}

export interface BenchmarkExecution {
  agent: string;
  model: string;
  provider: string;
  initialMode: ExecutionMode | "NATIVE";
  finalMode: ExecutionMode | "NATIVE";
  modeTransitions: Array<{
    from: ExecutionMode;
    to: ExecutionMode;
    reason: string;
    signalSnapshotId?: string;
  }>;
  signalSnapshots: RuntimeSignalSnapshot[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reportedCost: number | null;
  latencyMs: number;
  retryCount: number;
  verificationResult: BenchmarkVerificationResult;
  filesChanged: string[];
  contextExpansion: number;
  orchestrationOverheadMs: number;
}

export interface BenchmarkExecutor {
  strategy: BenchmarkStrategy;
  execute(task: BenchmarkTask): Promise<BenchmarkExecution>;
}

export interface BenchmarkSample extends BenchmarkExecution {
  task: BenchmarkTask;
  strategy: BenchmarkStrategy;
  costStatus: "REPORTED" | "UNKNOWN";
  verifiedSuccess: boolean;
}

export interface BenchmarkReport {
  generatedAt: string;
  samples: BenchmarkSample[];
  metrics: {
    sampleCount: number;
    verifiedSuccessRate: number;
    costPerVerifiedSuccess: number | null;
    verifiedRunsWithKnownCost: number;
  };
}

export class BenchmarkRunner {
  async compare(task: BenchmarkTask, executors: BenchmarkExecutor[]): Promise<BenchmarkReport> {
    const strategies = new Set(executors.map((executor) => executor.strategy));
    if (!strategies.has("NATIVE") || !strategies.has("MAF_ADAPTIVE")) {
      throw new Error("Benchmark comparison requires NATIVE and MAF_ADAPTIVE executors");
    }
    const samples = await Promise.all(
      executors.map(async (executor): Promise<BenchmarkSample> => {
        const execution = await executor.execute(task);
        return {
          ...execution,
          task: structuredClone(task),
          strategy: executor.strategy,
          costStatus: execution.reportedCost === null ? "UNKNOWN" : "REPORTED",
          verifiedSuccess: execution.verificationResult === "VERIFIED",
        };
      }),
    );
    const successes = samples.filter((sample) => sample.verifiedSuccess);
    const knownCostSuccesses = successes.filter((sample) => sample.reportedCost !== null);
    return {
      generatedAt: new Date().toISOString(),
      samples,
      metrics: {
        sampleCount: samples.length,
        verifiedSuccessRate: samples.length === 0 ? 0 : successes.length / samples.length,
        costPerVerifiedSuccess:
          knownCostSuccesses.length === 0
            ? null
            : knownCostSuccesses.reduce((total, sample) => total + (sample.reportedCost ?? 0), 0) /
              knownCostSuccesses.length,
        verifiedRunsWithKnownCost: knownCostSuccesses.length,
      },
    };
  }

  serialize(report: BenchmarkReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
}
