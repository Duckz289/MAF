import type { ExecutionMode, RuntimeSignalSnapshot } from "../domain/types";
import type {
  ExternalCheckOutcome,
  StrategyIdentity,
  StrategyObservation,
  StrategyScope,
} from "../domain/strategy";
import { assertStrategyObservation } from "../domain/strategy";

export type BenchmarkStrategy = "NATIVE" | "MAF_ADAPTIVE";
export type BenchmarkVerificationResult = "VERIFIED" | "QUARANTINED" | "FAILED";

export interface BenchmarkTask {
  id: string;
  prompt: string;
  expectedVerification: string;
  /** Optional M12 scope turns benchmark outcomes into shadow evidence, never global claims. */
  strategyScope?: StrategyScope;
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
  verificationAttempts: number;
  repairAttempts: number;
  verifierFailures: number;
  verificationResult: BenchmarkVerificationResult;
  filesChanged: string[];
  modulesTouched: string[];
  contextExpansion: number;
  orchestrationOverheadMs: number;
  runId?: string;
  candidateId?: string;
  trustState?: StrategyObservation["trustState"];
  qualityOutcome?: StrategyObservation["qualityOutcome"];
  security?: ExternalCheckOutcome;
  performance?: ExternalCheckOutcome;
  resilience?: ExternalCheckOutcome;
  healthEffect?: StrategyObservation["healthEffect"];
}

export interface BenchmarkExecutor {
  strategy: BenchmarkStrategy;
  /** Full execution identity; a label alone is not promotion evidence. */
  identity?: StrategyIdentity;
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
  /** Shadow evidence only; promotion still applies M12 scoped minimums. */
  strategyEvidence: StrategyObservation[];
}

const modes = new Set<BenchmarkExecution["initialMode"]>([
  "STRICT",
  "GUIDED",
  "SOLO_NATIVE",
  "NATIVE",
]);
const verificationResults = new Set<BenchmarkVerificationResult>([
  "VERIFIED",
  "QUARANTINED",
  "FAILED",
]);
const nonnegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

/** Runtime boundary for executor JSON: absent cost is UNKNOWN; malformed metrics fail closed. */
export const normalizeBenchmarkExecution = (value: unknown): BenchmarkExecution => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Benchmark executor returned a malformed payload");
  const raw = value as Record<string, unknown>;
  for (const field of ["agent", "model", "provider"] as const) {
    if (typeof raw[field] !== "string" || raw[field].length === 0)
      throw new Error(`Benchmark executor field ${field} is required`);
  }
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "latencyMs",
    "retryCount",
    "verificationAttempts",
    "repairAttempts",
    "verifierFailures",
    "contextExpansion",
    "orchestrationOverheadMs",
  ] as const) {
    if (!nonnegativeNumber(raw[field]))
      throw new Error(`Benchmark executor field ${field} must be finite and non-negative`);
  }
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "retryCount",
    "verificationAttempts",
    "repairAttempts",
    "verifierFailures",
    "contextExpansion",
  ] as const) {
    if (!Number.isInteger(raw[field]))
      throw new Error(`Benchmark executor field ${field} must be an integer`);
  }
  if (
    !modes.has(raw.initialMode as BenchmarkExecution["initialMode"]) ||
    !modes.has(raw.finalMode as BenchmarkExecution["finalMode"])
  )
    throw new Error("Benchmark executor returned an invalid execution mode");
  if (!verificationResults.has(raw.verificationResult as BenchmarkVerificationResult))
    throw new Error("Benchmark executor returned an invalid verification result");
  if (!Array.isArray(raw.modeTransitions) || !Array.isArray(raw.signalSnapshots))
    throw new Error("Benchmark executor transition/snapshot evidence must be arrays");
  if (
    !raw.modeTransitions.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const transition = entry as Record<string, unknown>;
      return (
        modes.has(transition.from as BenchmarkExecution["initialMode"]) &&
        transition.from !== "NATIVE" &&
        modes.has(transition.to as BenchmarkExecution["initialMode"]) &&
        transition.to !== "NATIVE" &&
        typeof transition.reason === "string" &&
        optionalString(transition.signalSnapshotId)
      );
    })
  )
    throw new Error("Benchmark executor returned malformed mode-transition evidence");
  if (
    !raw.signalSnapshots.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const snapshot = entry as Record<string, unknown>;
      return (
        typeof snapshot.id === "string" &&
        typeof snapshot.runId === "string" &&
        Number.isInteger(snapshot.sequence) &&
        typeof snapshot.checkpoint === "string" &&
        typeof snapshot.timestamp === "string" &&
        Number.isFinite(Date.parse(snapshot.timestamp)) &&
        typeof snapshot.signals === "object" &&
        snapshot.signals !== null &&
        Array.isArray(snapshot.evidence)
      );
    })
  )
    throw new Error("Benchmark executor returned malformed signal-snapshot evidence");
  if (!stringArray(raw.filesChanged) || !stringArray(raw.modulesTouched))
    throw new Error("Benchmark executor file/module evidence must be string arrays");
  if (
    raw.reportedCost !== undefined &&
    raw.reportedCost !== null &&
    !nonnegativeNumber(raw.reportedCost)
  )
    throw new Error("Benchmark executor reported cost must be finite and non-negative");
  if (!optionalString(raw.runId) || !optionalString(raw.candidateId))
    throw new Error("Benchmark executor returned malformed run/candidate identity");
  if (
    raw.trustState !== undefined &&
    ![
      "PROPOSED",
      "CORRECTNESS_VERIFIED",
      "QUALITY_VERIFIED",
      "DURABLE_VERIFIED",
      "MERGE_ELIGIBLE",
      "NATIVE_VERIFIED",
      "UNKNOWN",
    ].includes(raw.trustState as string)
  )
    throw new Error("Benchmark executor returned an invalid trust state");
  for (const field of ["security", "performance", "resilience"] as const) {
    if (
      raw[field] !== undefined &&
      !["PASS", "FAIL", "NOT_CHECKED", "NOT_REQUIRED"].includes(raw[field] as string)
    )
      throw new Error(`Benchmark executor returned an invalid ${field} outcome`);
  }
  if (
    raw.qualityOutcome !== undefined &&
    !["PASS", "FAIL", "UNKNOWN"].includes(raw.qualityOutcome as string)
  )
    throw new Error("Benchmark executor returned an invalid quality outcome");
  if (
    raw.healthEffect !== undefined &&
    !["STABLE", "DEGRADING", "UNKNOWN"].includes(raw.healthEffect as string)
  )
    throw new Error("Benchmark executor returned an invalid health effect");
  return {
    ...(raw as unknown as BenchmarkExecution),
    reportedCost: raw.reportedCost === undefined ? null : (raw.reportedCost as number | null),
  };
};

const assertAttribution = (
  benchmarkStrategy: BenchmarkStrategy,
  identity: StrategyIdentity,
  execution: BenchmarkExecution,
): void => {
  if (
    identity.adapter !== execution.agent ||
    identity.model !== execution.model ||
    identity.provider !== execution.provider ||
    identity.executionMode !== execution.finalMode ||
    (benchmarkStrategy === "NATIVE" &&
      (identity.baseline !== "NATIVE_FRONTIER" ||
        execution.initialMode !== "NATIVE" ||
        execution.finalMode !== "NATIVE")) ||
    (benchmarkStrategy === "MAF_ADAPTIVE" &&
      (identity.baseline !== "CHALLENGER" || execution.finalMode === "NATIVE"))
  ) {
    throw new Error("Benchmark strategy identity does not match the executor result");
  }
};

export class BenchmarkRunner {
  async compare(task: BenchmarkTask, executors: BenchmarkExecutor[]): Promise<BenchmarkReport> {
    const strategies = new Set(executors.map((executor) => executor.strategy));
    if (!strategies.has("NATIVE") || !strategies.has("MAF_ADAPTIVE")) {
      throw new Error("Benchmark comparison requires NATIVE and MAF_ADAPTIVE executors");
    }
    const generatedAt = new Date().toISOString();
    const samples = await Promise.all(
      executors.map(async (executor): Promise<BenchmarkSample> => {
        const execution = normalizeBenchmarkExecution(await executor.execute(task));
        if (task.strategyScope && executor.identity)
          assertAttribution(executor.strategy, executor.identity, execution);
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
    const strategyEvidence = samples.flatMap((sample, index): StrategyObservation[] => {
      const executor = executors[index];
      if (!task.strategyScope || !executor?.identity) return [];
      const observation: StrategyObservation = {
        id: `benchmark:${task.id}:${sample.strategy}:${index}`,
        timestamp: generatedAt,
        scope: structuredClone(task.strategyScope),
        strategy: structuredClone(executor.identity),
        ...(sample.runId ? { runId: sample.runId } : {}),
        ...(sample.candidateId ? { candidateId: sample.candidateId } : {}),
        verifiedSuccess: sample.verifiedSuccess,
        trustState:
          sample.trustState ??
          (sample.strategy === "NATIVE" && sample.verifiedSuccess ? "NATIVE_VERIFIED" : "UNKNOWN"),
        costUsd: sample.reportedCost,
        latencyMs: sample.latencyMs,
        retries: sample.retryCount,
        qualityOutcome: sample.qualityOutcome ?? "UNKNOWN",
        security: sample.security ?? "NOT_CHECKED",
        performance: sample.performance ?? "NOT_CHECKED",
        resilience: sample.resilience ?? "NOT_CHECKED",
        healthEffect: sample.healthEffect ?? "UNKNOWN",
        source: "BENCHMARK_SHADOW",
        evidenceBasis: "BENCHMARK_OBSERVED",
      };
      assertStrategyObservation(observation);
      return [observation];
    });
    return {
      generatedAt,
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
      strategyEvidence,
    };
  }

  serialize(report: BenchmarkReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
}
