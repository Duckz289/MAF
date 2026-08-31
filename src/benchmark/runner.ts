import type { ExecutionMode, RuntimeSignalSnapshot } from "../domain/types";
import type {
  ExternalCheckOutcome,
  StrategyIdentity,
  StrategyObservation,
  StrategyScope,
} from "../domain/strategy";
import { assertStrategyObservation } from "../domain/strategy";
import { redactSensitiveData, redactSensitiveText } from "../domain/security";
import { evaluateBenchmarkSamples } from "../evaluation/benchmark-bridge";
import {
  nullIndependentVerifier,
  type IndependentVerificationResult,
  type IndependentVerifier,
} from "../evaluation/independent-verification";
import type { EvaluationMetrics } from "../evaluation/types";

export type BenchmarkStrategy = "NATIVE" | "MAF_ADAPTIVE";
export type BenchmarkVerificationResult = "VERIFIED" | "QUARANTINED" | "FAILED";
export type BenchmarkFamily =
  | "SMALL_MECHANICAL"
  | "CROSS_MODULE_FEATURE"
  | "VERIFIER_REPAIR"
  | "SECURITY_SENSITIVE"
  | "DATA_CONSISTENCY"
  | "NETWORK_PERFORMANCE"
  | "RESILIENCE_INJECTION"
  | "PROVIDER_RECOVERY"
  | "INSUFFICIENT_BUDGET"
  | "LONG_HORIZON_EVOLUTION";

export interface BenchmarkTask {
  id: string;
  prompt: string;
  expectedVerification: string;
  /**
   * Workspaces the CONTROLLER allocated for each participant, keyed by strategy. The independent
   * verifier inspects these paths after execution. They are deliberately part of the task rather
   * than of a participant's execution report: a path a participant could name is a path it could
   * fabricate.
   */
  candidateWorkspaces?: Partial<Record<BenchmarkStrategy, string>>;
  /** Optional M12 scope turns benchmark outcomes into shadow evidence, never global claims. */
  strategyScope?: StrategyScope;
  family?: BenchmarkFamily;
  sequence?: { id: string; checkpoint: number };
  changeability?: {
    comparisonClass: string;
    workload: string;
    role: "EVOLUTION" | "N_PLUS_ONE";
  };
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
  toolCalls?: number;
  contextTokens?: number;
  sequenceEvidence?: {
    sequenceId: string;
    checkpoint: number;
    baseStateDigest: string | null;
    resultStateDigest: string;
    candidateStateDigest: string;
    verifiedStateDigest: string;
  };
  scenarioEvidence?: {
    family: BenchmarkFamily;
    outcome: "EXERCISED" | "FAILED" | "NOT_APPLICABLE";
    checks: string[];
  };
  runId?: string;
  candidateId?: string;
  /** Infrastructure signals. Absent means the execution completed; a non-COMPLETED status or an
   *  error string makes the run INVALID for protocol accounting and can never become a DVS. */
  executionStatus?: "COMPLETED" | "INFRA_FAILURE" | "TIMEOUT" | "CANCELLED" | "QUOTA_EXHAUSTED";
  providerError?: string;
  infrastructureError?: string;
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
  /** Protocol accounting for this comparison, derived from the samples through
   *  src/evaluation/benchmark-bridge.ts. This is where DVS, false-safe, invalid-run separation and
   *  cost-per-DVS are actually applied to an evaluation flow. */
  evaluation: EvaluationMetrics;
  /** Shadow evidence only; promotion still applies M12 scoped minimums. */
  strategyEvidence: StrategyObservation[];
}

export interface BenchmarkSuiteReport {
  generatedAt: string;
  evidenceBasis: "EXECUTOR_REPORTED_STATE_CHAIN";
  causalClaim: "NONE";
  reports: BenchmarkReport[];
  coverage: {
    evidenceBasis: "EXECUTOR_ASSERTED_CHECKS";
    declaredFamilies: BenchmarkFamily[];
    exercisedFamilies: BenchmarkFamily[];
    missingFamilies: BenchmarkFamily[];
    complete: boolean;
  };
  longHorizon: Array<{
    sequenceId: string;
    checkpoints: number;
    firstCheckpoint: number;
    lastCheckpoint: number;
    chainValidated: true;
    sufficient: boolean;
  }>;
  changeability: Array<{
    comparisonClass: string;
    strategy: BenchmarkStrategy;
    beforeTaskId: string;
    nPlusOneTaskId: string;
    deltas: {
      tokens: number;
      latencyMs: number;
      retries: number;
      filesChanged: number;
      contextExpansion: number;
      contextTokens: number | null;
      toolCalls: number | null;
    };
    causalClaim: "NONE";
  }>;
}

export const benchmarkFamilies: BenchmarkFamily[] = [
  "SMALL_MECHANICAL",
  "CROSS_MODULE_FEATURE",
  "VERIFIER_REPAIR",
  "SECURITY_SENSITIVE",
  "DATA_CONSISTENCY",
  "NETWORK_PERFORMANCE",
  "RESILIENCE_INJECTION",
  "PROVIDER_RECOVERY",
  "INSUFFICIENT_BUDGET",
  "LONG_HORIZON_EVOLUTION",
];

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
const stateDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const benchmarkFamily = (value: unknown): value is BenchmarkFamily =>
  typeof value === "string" && benchmarkFamilies.includes(value as BenchmarkFamily);

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
  for (const field of ["toolCalls", "contextTokens"] as const) {
    if (
      raw[field] !== undefined &&
      (!nonnegativeNumber(raw[field]) || !Number.isInteger(raw[field]))
    )
      throw new Error(`Benchmark executor field ${field} must be a non-negative integer`);
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
  let priorSnapshotSequence = -1;
  let priorSnapshotTime = Number.NEGATIVE_INFINITY;
  for (const entry of raw.signalSnapshots as Array<Record<string, unknown>>) {
    const sequence = entry.sequence as number;
    const timestamp = Date.parse(entry.timestamp as string);
    if (sequence <= priorSnapshotSequence || timestamp < priorSnapshotTime)
      throw new Error("Benchmark signal snapshots must be strictly sequenced and time ordered");
    priorSnapshotSequence = sequence;
    priorSnapshotTime = timestamp;
  }
  const snapshotIds = new Set(
    raw.signalSnapshots.map((entry) => (entry as Record<string, unknown>).id as string),
  );
  if (snapshotIds.size !== raw.signalSnapshots.length)
    throw new Error("Benchmark executor returned duplicate signal-snapshot evidence");
  if (!stringArray(raw.filesChanged) || !stringArray(raw.modulesTouched))
    throw new Error("Benchmark executor file/module evidence must be string arrays");
  for (const [field, values] of [
    ["filesChanged", raw.filesChanged],
    ["modulesTouched", raw.modulesTouched],
  ] as const) {
    if (values.some((entry) => entry.length === 0) || new Set(values).size !== values.length)
      throw new Error(`Benchmark executor ${field} must contain unique non-empty values`);
  }
  if (
    raw.reportedCost !== undefined &&
    raw.reportedCost !== null &&
    !nonnegativeNumber(raw.reportedCost)
  )
    throw new Error("Benchmark executor reported cost must be finite and non-negative");
  if (!optionalString(raw.runId) || !optionalString(raw.candidateId))
    throw new Error("Benchmark executor returned malformed run/candidate identity");
  if (
    raw.executionStatus !== undefined &&
    !["COMPLETED", "INFRA_FAILURE", "TIMEOUT", "CANCELLED", "QUOTA_EXHAUSTED"].includes(
      raw.executionStatus as string,
    )
  )
    throw new Error("Benchmark executor returned an invalid execution status");
  if (!optionalString(raw.providerError) || !optionalString(raw.infrastructureError))
    throw new Error("Benchmark executor returned malformed infrastructure errors");
  if (
    raw.signalSnapshots.length > 0 &&
    (typeof raw.runId !== "string" ||
      raw.signalSnapshots.some((entry) => (entry as Record<string, unknown>).runId !== raw.runId))
  )
    throw new Error("Benchmark signal snapshots are not bound to the execution run");
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
  if (
    raw.verificationResult === "VERIFIED" &&
    ((raw.verificationAttempts as number) < 1 ||
      (raw.verifierFailures as number) >= (raw.verificationAttempts as number))
  )
    throw new Error("VERIFIED benchmark evidence requires a successful verification attempt");
  if ((raw.repairAttempts as number) > (raw.verifierFailures as number))
    throw new Error("Benchmark repair attempts cannot exceed verifier failures");
  let transitionMode = raw.initialMode as BenchmarkExecution["initialMode"];
  for (const entry of raw.modeTransitions as Array<Record<string, unknown>>) {
    if (
      transitionMode === "NATIVE" ||
      entry.from !== transitionMode ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0 ||
      typeof entry.signalSnapshotId !== "string" ||
      !snapshotIds.has(entry.signalSnapshotId)
    )
      throw new Error("Benchmark mode transitions must form an evidence-bound contiguous chain");
    transitionMode = entry.to as ExecutionMode;
  }
  if (transitionMode !== raw.finalMode)
    throw new Error("Benchmark final mode does not match its transition chain");
  if (raw.sequenceEvidence !== undefined) {
    if (
      typeof raw.sequenceEvidence !== "object" ||
      raw.sequenceEvidence === null ||
      Array.isArray(raw.sequenceEvidence)
    )
      throw new Error("Benchmark executor returned malformed sequence evidence");
    const evidence = raw.sequenceEvidence as Record<string, unknown>;
    if (
      typeof evidence.sequenceId !== "string" ||
      evidence.sequenceId.length === 0 ||
      !Number.isInteger(evidence.checkpoint) ||
      (evidence.checkpoint as number) <= 0 ||
      (evidence.baseStateDigest !== null && !stateDigest(evidence.baseStateDigest)) ||
      !stateDigest(evidence.resultStateDigest) ||
      !stateDigest(evidence.candidateStateDigest) ||
      !stateDigest(evidence.verifiedStateDigest)
    )
      throw new Error("Benchmark executor returned malformed sequence evidence");
  }
  if (raw.scenarioEvidence !== undefined) {
    if (
      typeof raw.scenarioEvidence !== "object" ||
      raw.scenarioEvidence === null ||
      Array.isArray(raw.scenarioEvidence)
    )
      throw new Error("Benchmark executor returned malformed scenario evidence");
    const evidence = raw.scenarioEvidence as Record<string, unknown>;
    if (
      !benchmarkFamily(evidence.family) ||
      !["EXERCISED", "FAILED", "NOT_APPLICABLE"].includes(evidence.outcome as string) ||
      !stringArray(evidence.checks) ||
      evidence.checks.length === 0 ||
      evidence.checks.length > 20 ||
      evidence.checks.some((entry) => entry.length === 0 || entry.length > 200)
    )
      throw new Error("Benchmark executor returned malformed scenario evidence");
  }
  const safeSnapshots = (redactSensitiveData(raw.signalSnapshots) as RuntimeSignalSnapshot[]).map(
    (snapshot) => ({
      id: snapshot.id,
      runId: snapshot.runId,
      sequence: snapshot.sequence,
      checkpoint: snapshot.checkpoint,
      timestamp: snapshot.timestamp,
      signals: snapshot.signals,
      evidence: snapshot.evidence,
    }),
  );
  if (JSON.stringify(safeSnapshots).length > 1_000_000)
    throw new Error("Benchmark signal-snapshot evidence exceeds its size limit");
  const boundedText = (value: string, length: number): string =>
    redactSensitiveText(value).slice(0, length);
  const result: BenchmarkExecution = {
    agent: boundedText(raw.agent as string, 200),
    model: boundedText(raw.model as string, 200),
    provider: boundedText(raw.provider as string, 200),
    initialMode: raw.initialMode as BenchmarkExecution["initialMode"],
    finalMode: raw.finalMode as BenchmarkExecution["finalMode"],
    modeTransitions: (raw.modeTransitions as BenchmarkExecution["modeTransitions"]).map(
      (transition) => ({
        from: transition.from,
        to: transition.to,
        reason: boundedText(transition.reason, 500),
        ...(transition.signalSnapshotId
          ? { signalSnapshotId: boundedText(transition.signalSnapshotId, 200) }
          : {}),
      }),
    ),
    signalSnapshots: safeSnapshots,
    inputTokens: raw.inputTokens as number,
    outputTokens: raw.outputTokens as number,
    cachedTokens: raw.cachedTokens as number,
    reportedCost: raw.reportedCost === undefined ? null : (raw.reportedCost as number | null),
    latencyMs: raw.latencyMs as number,
    retryCount: raw.retryCount as number,
    verificationAttempts: raw.verificationAttempts as number,
    repairAttempts: raw.repairAttempts as number,
    verifierFailures: raw.verifierFailures as number,
    verificationResult: raw.verificationResult as BenchmarkVerificationResult,
    filesChanged: (raw.filesChanged as string[]).map((entry) => boundedText(entry, 500)),
    modulesTouched: (raw.modulesTouched as string[]).map((entry) => boundedText(entry, 500)),
    contextExpansion: raw.contextExpansion as number,
    orchestrationOverheadMs: raw.orchestrationOverheadMs as number,
    ...(raw.toolCalls !== undefined ? { toolCalls: raw.toolCalls as number } : {}),
    ...(raw.contextTokens !== undefined ? { contextTokens: raw.contextTokens as number } : {}),
    ...(typeof raw.runId === "string" ? { runId: boundedText(raw.runId, 200) } : {}),
    ...(typeof raw.candidateId === "string"
      ? { candidateId: boundedText(raw.candidateId, 200) }
      : {}),
    ...(raw.executionStatus !== undefined
      ? {
          executionStatus: raw.executionStatus as NonNullable<
            BenchmarkExecution["executionStatus"]
          >,
        }
      : {}),
    ...(typeof raw.providerError === "string"
      ? { providerError: boundedText(raw.providerError, 500) }
      : {}),
    ...(typeof raw.infrastructureError === "string"
      ? { infrastructureError: boundedText(raw.infrastructureError, 500) }
      : {}),
    ...(raw.trustState !== undefined
      ? { trustState: raw.trustState as NonNullable<BenchmarkExecution["trustState"]> }
      : {}),
    ...(raw.qualityOutcome !== undefined
      ? {
          qualityOutcome: raw.qualityOutcome as NonNullable<BenchmarkExecution["qualityOutcome"]>,
        }
      : {}),
    ...(raw.security !== undefined ? { security: raw.security as ExternalCheckOutcome } : {}),
    ...(raw.performance !== undefined
      ? { performance: raw.performance as ExternalCheckOutcome }
      : {}),
    ...(raw.resilience !== undefined ? { resilience: raw.resilience as ExternalCheckOutcome } : {}),
    ...(raw.healthEffect !== undefined
      ? { healthEffect: raw.healthEffect as NonNullable<BenchmarkExecution["healthEffect"]> }
      : {}),
  };
  if (raw.sequenceEvidence !== undefined) {
    const evidence = raw.sequenceEvidence as NonNullable<BenchmarkExecution["sequenceEvidence"]>;
    result.sequenceEvidence = {
      sequenceId: boundedText(evidence.sequenceId, 200),
      checkpoint: evidence.checkpoint,
      baseStateDigest: evidence.baseStateDigest,
      resultStateDigest: evidence.resultStateDigest,
      candidateStateDigest: evidence.candidateStateDigest,
      verifiedStateDigest: evidence.verifiedStateDigest,
    };
  }
  if (raw.scenarioEvidence !== undefined) {
    const evidence = raw.scenarioEvidence as NonNullable<BenchmarkExecution["scenarioEvidence"]>;
    result.scenarioEvidence = {
      family: evidence.family,
      outcome: evidence.outcome,
      checks: evidence.checks.map((entry) => boundedText(entry, 200)),
    };
  }
  return result;
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

const boundedSafeText = (value: string, length: number): string =>
  redactSensitiveText(value).slice(0, length);

const safeStrategyIdentity = (identity: StrategyIdentity): StrategyIdentity => ({
  adapter: boundedSafeText(identity.adapter, 200),
  model: boundedSafeText(identity.model, 200),
  provider: boundedSafeText(identity.provider, 200),
  executionMode: identity.executionMode,
  qualityPreference: identity.qualityPreference,
  verificationProfile: boundedSafeText(identity.verificationProfile, 200),
  reviewPolicy: identity.reviewPolicy,
  baseline: identity.baseline,
});

const safeBenchmarkTask = (task: BenchmarkTask): BenchmarkTask => ({
  id: boundedSafeText(task.id, 200),
  prompt: boundedSafeText(task.prompt, 4_000),
  expectedVerification: boundedSafeText(task.expectedVerification, 1_000),
  ...(task.strategyScope
    ? {
        strategyScope: {
          projectId: task.strategyScope.projectId,
          taskClass: boundedSafeText(task.strategyScope.taskClass, 200),
          riskProfile: boundedSafeText(task.strategyScope.riskProfile, 200),
          qualityRequirement: task.strategyScope.qualityRequirement,
        },
      }
    : {}),
  ...(task.candidateWorkspaces ? { candidateWorkspaces: { ...task.candidateWorkspaces } } : {}),
  ...(task.family ? { family: task.family } : {}),
  ...(task.sequence
    ? {
        sequence: {
          id: boundedSafeText(task.sequence.id, 200),
          checkpoint: task.sequence.checkpoint,
        },
      }
    : {}),
  ...(task.changeability
    ? {
        changeability: {
          comparisonClass: boundedSafeText(task.changeability.comparisonClass, 200),
          workload: boundedSafeText(task.changeability.workload, 1_000),
          role: task.changeability.role,
        },
      }
    : {}),
});

/** The revision the comparison ran against, taken from the executor-reported state chain. Absent
 *  evidence stays UNKNOWN rather than being invented. */
const sourceRevisionOf = (samples: BenchmarkSample[]): string =>
  samples.find((sample) => sample.sequenceEvidence?.baseStateDigest)?.sequenceEvidence
    ?.baseStateDigest ?? "UNKNOWN";

export class BenchmarkRunner {
  /**
   * Compares one NATIVE and one MAF_ADAPTIVE participant on a task.
   *
   * `options.verifier` is the controller-side independent verifier. It runs AFTER the participants
   * have finished, over a workspace the controller owns, and it is the only thing that can
   * establish correctness evidence. Omitting it does not make runs succeed on the participants'
   * word: every run then carries NOT_CHECKED evidence and no run can be a Durable Verified Success.
   */
  async compare(
    task: BenchmarkTask,
    executors: BenchmarkExecutor[],
    options: { verifier?: IndependentVerifier } = {},
  ): Promise<BenchmarkReport> {
    const nativeCount = executors.filter((executor) => executor.strategy === "NATIVE").length;
    const adaptiveCount = executors.filter(
      (executor) => executor.strategy === "MAF_ADAPTIVE",
    ).length;
    if (executors.length !== 2 || nativeCount !== 1 || adaptiveCount !== 1) {
      throw new Error(
        "Benchmark comparison requires exactly one NATIVE and one MAF_ADAPTIVE executor",
      );
    }
    const generatedAt = new Date().toISOString();
    const projectedTask = safeBenchmarkTask(task);
    const samples = await Promise.all(
      executors.map(async (executor): Promise<BenchmarkSample> => {
        const execution = normalizeBenchmarkExecution(await executor.execute(task));
        if (task.strategyScope && !executor.identity)
          throw new Error("Scoped benchmark execution requires full strategy identity");
        if (executor.identity) assertAttribution(executor.strategy, executor.identity, execution);
        return {
          ...execution,
          task: structuredClone(projectedTask),
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
        scope: structuredClone(projectedTask.strategyScope as StrategyScope),
        strategy: safeStrategyIdentity(executor.identity),
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
    // Independent verification runs here: after participant execution, before any accounting. It is
    // deliberately not given the participant's execution object, so nothing it decides can depend on
    // what the participant claimed.
    const verifier = options.verifier ?? nullIndependentVerifier;
    const verifications = new Map<BenchmarkSample, IndependentVerificationResult>();
    for (const sample of samples) {
      verifications.set(
        sample,
        await verifier.verify({
          taskId: projectedTask.id,
          expectedVerification: projectedTask.expectedVerification,
          ...(projectedTask.candidateWorkspaces?.[sample.strategy]
            ? { workspacePath: projectedTask.candidateWorkspaces[sample.strategy] as string }
            : {}),
        }),
      );
    }
    return {
      generatedAt,
      samples,
      evaluation: evaluateBenchmarkSamples(samples, sourceRevisionOf(samples), verifications),
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

  /** Runs a suite. `options.verifier` is threaded to every comparison; see `compare`. */
  async runSuite(
    tasks: BenchmarkTask[],
    executors: BenchmarkExecutor[],
    options: { verifier?: IndependentVerifier } = {},
  ): Promise<BenchmarkSuiteReport> {
    if (tasks.length === 0) throw new Error("Benchmark suite requires at least one task");
    if (executors.some((executor) => !executor.identity))
      throw new Error("Integrated benchmark suites require full strategy identities");
    const reports: BenchmarkReport[] = [];
    const sequenceState = new Map<
      string,
      {
        checkpoint: number;
        resultStateDigests: string[];
        seenRunIds: Array<Set<string>>;
        seenCandidateIds: Array<Set<string>>;
      }
    >();
    // Deliberately sequential, with a required state chain: labels alone are not long-horizon proof.
    for (const task of tasks) {
      const report = await this.compare(task, executors, options);
      reports.push(report);
      if (!task.sequence) continue;
      const prior = sequenceState.get(task.sequence.id);
      const expectedCheckpoint = (prior?.checkpoint ?? 0) + 1;
      if (task.sequence.checkpoint !== expectedCheckpoint) {
        throw new Error(
          `Benchmark sequence ${task.sequence.id} expected checkpoint ${expectedCheckpoint}, received ${task.sequence.checkpoint}`,
        );
      }
      const resultStateDigests = report.samples.map((sample, index) => {
        const evidence = sample.sequenceEvidence;
        if (
          !evidence ||
          evidence.sequenceId !== task.sequence?.id ||
          evidence.checkpoint !== task.sequence.checkpoint ||
          evidence.baseStateDigest !== (prior?.resultStateDigests[index] ?? null) ||
          evidence.resultStateDigest === evidence.baseStateDigest ||
          evidence.candidateStateDigest !== evidence.resultStateDigest ||
          evidence.verifiedStateDigest !== evidence.resultStateDigest ||
          sample.verificationResult !== "VERIFIED" ||
          !sample.runId ||
          !sample.candidateId
        ) {
          throw new Error(
            `Benchmark sequence ${task.sequence?.id} checkpoint ${task.sequence?.checkpoint} lacks a valid state-chain binding`,
          );
        }
        if (
          prior?.seenRunIds[index]?.has(sample.runId) ||
          prior?.seenCandidateIds[index]?.has(sample.candidateId)
        )
          throw new Error(
            `Benchmark sequence ${task.sequence?.id} checkpoint ${task.sequence?.checkpoint} reused a prior run or candidate identity`,
          );
        return evidence.resultStateDigest;
      });
      sequenceState.set(task.sequence.id, {
        checkpoint: task.sequence.checkpoint,
        resultStateDigests,
        seenRunIds: report.samples.map(
          (sample, index) => new Set([...(prior?.seenRunIds[index] ?? []), sample.runId as string]),
        ),
        seenCandidateIds: report.samples.map(
          (sample, index) =>
            new Set([...(prior?.seenCandidateIds[index] ?? []), sample.candidateId as string]),
        ),
      });
    }
    const declaredFamilies = benchmarkFamilies.filter((family) =>
      tasks.some((task) => task.family === family),
    );
    const exercisedFamilies = benchmarkFamilies.filter((family) =>
      tasks.some((task, index) => {
        if (task.family !== family) return false;
        return reports[index]?.samples.every(
          (sample) =>
            sample.scenarioEvidence?.family === family &&
            sample.scenarioEvidence.outcome === "EXERCISED" &&
            sample.scenarioEvidence.checks.length > 0,
        );
      }),
    );
    const missingFamilies = benchmarkFamilies.filter(
      (family) => !exercisedFamilies.includes(family),
    );
    const sequenceIds = [
      ...new Set(tasks.flatMap((task) => (task.sequence ? [task.sequence.id] : []))),
    ];
    const longHorizon = sequenceIds.map((sequenceId) => {
      const checkpoints = tasks
        .filter((task) => task.sequence?.id === sequenceId)
        .map((task) => task.sequence?.checkpoint ?? 0);
      return {
        sequenceId,
        checkpoints: checkpoints.length,
        firstCheckpoint: checkpoints[0] ?? 0,
        lastCheckpoint: checkpoints.at(-1) ?? 0,
        chainValidated: true as const,
        sufficient: checkpoints.length >= 10,
      };
    });
    const changeability: BenchmarkSuiteReport["changeability"] = [];
    for (const task of tasks.filter((entry) => entry.changeability?.role === "N_PLUS_ONE")) {
      const comparisonClass = task.changeability?.comparisonClass;
      if (!comparisonClass) continue;
      const taskIndex = tasks.indexOf(task);
      const prior = tasks
        .slice(0, taskIndex)
        .filter(
          (entry) =>
            entry.changeability?.comparisonClass === comparisonClass &&
            entry.changeability.role === "EVOLUTION",
        )
        .at(-1);
      if (
        !prior ||
        !task.sequence ||
        !prior.sequence ||
        task.sequence.id !== prior.sequence.id ||
        task.changeability?.workload !== prior.changeability?.workload
      )
        throw new Error(`N+1 task ${task.id} lacks a bound prior comparable evolution task`);
      const currentReport = reports[tasks.indexOf(task)];
      const priorReport = reports[tasks.indexOf(prior)];
      for (const strategy of ["NATIVE", "MAF_ADAPTIVE"] as const) {
        const current = currentReport?.samples.find((sample) => sample.strategy === strategy);
        const before = priorReport?.samples.find((sample) => sample.strategy === strategy);
        if (!current || !before) continue;
        changeability.push({
          comparisonClass,
          strategy,
          beforeTaskId: prior.id,
          nPlusOneTaskId: task.id,
          deltas: {
            tokens:
              current.inputTokens + current.outputTokens - before.inputTokens - before.outputTokens,
            latencyMs: current.latencyMs - before.latencyMs,
            retries: current.retryCount - before.retryCount,
            filesChanged: current.filesChanged.length - before.filesChanged.length,
            contextExpansion: current.contextExpansion - before.contextExpansion,
            contextTokens:
              current.contextTokens === undefined || before.contextTokens === undefined
                ? null
                : current.contextTokens - before.contextTokens,
            toolCalls:
              current.toolCalls === undefined || before.toolCalls === undefined
                ? null
                : current.toolCalls - before.toolCalls,
          },
          causalClaim: "NONE",
        });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      evidenceBasis: "EXECUTOR_REPORTED_STATE_CHAIN",
      causalClaim: "NONE",
      reports,
      coverage: {
        evidenceBasis: "EXECUTOR_ASSERTED_CHECKS",
        declaredFamilies,
        exercisedFamilies,
        missingFamilies,
        complete: missingFamilies.length === 0,
      },
      longHorizon,
      changeability,
    };
  }

  serializeSuite(report: BenchmarkSuiteReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
}
