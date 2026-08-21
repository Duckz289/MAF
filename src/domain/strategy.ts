import { createHash } from "node:crypto";
import type { QualityPreference } from "./assurance";
import type { QualityReport } from "./quality";
import type { RiskVector } from "./risk";
import { redactSensitiveText } from "./security";
import type {
  Artifact,
  ExecutionMode,
  Run,
  StrategyObservationBinding,
  Task,
  TrustState,
} from "./types";

/** M12 strategy learning is scoped evidence, never a global model leaderboard. */
export interface StrategyIdentity {
  adapter: string;
  model: string;
  provider: string;
  executionMode: ExecutionMode | "NATIVE";
  qualityPreference: QualityPreference;
  verificationProfile: string;
  reviewPolicy: "NONE" | "REQUIRED";
  baseline: "NATIVE_FRONTIER" | "CHALLENGER";
}

export interface StrategyScope {
  projectId: string;
  taskClass: string;
  riskProfile: string;
  qualityRequirement: QualityPreference;
}

export type ExternalCheckOutcome = "PASS" | "FAIL" | "NOT_CHECKED" | "NOT_REQUIRED";

export interface StrategyObservation {
  id: string;
  timestamp: string;
  scope: StrategyScope;
  strategy: StrategyIdentity;
  runId?: string;
  candidateId?: string;
  candidateDigest?: string;
  verifiedSuccess: boolean;
  trustState: TrustState | "NATIVE_VERIFIED" | "UNKNOWN";
  costUsd: number | null;
  latencyMs: number;
  retries: number;
  qualityOutcome: "PASS" | "FAIL" | "UNKNOWN";
  security: ExternalCheckOutcome;
  performance: ExternalCheckOutcome;
  resilience: ExternalCheckOutcome;
  healthEffect: "STABLE" | "DEGRADING" | "UNKNOWN";
  source: "RUN" | "BENCHMARK_SHADOW";
  /** Only store-bound run evidence can support durable promotion. */
  evidenceBasis: "RUN_STORE_VERIFIED" | "RUN_STORE_TERMINAL" | "BENCHMARK_OBSERVED";
}

export type StrategyLifecycle = "SHADOW" | "CANARY" | "PROMOTED" | "DEMOTED";

export interface StrategyPolicy {
  canaryMinimumObservations: number;
  promotionMinimumObservations: number;
  promotionMinimumDurableSuccesses: number;
  promotionMinimumKnownCosts: number;
  promotionMinimumVerifiedRate: number;
  demotionRecentWindow: number;
  demotionMaximumRecentFailureRate: number;
  demotionHealthEvents: number;
}

export const defaultStrategyPolicy: StrategyPolicy = {
  canaryMinimumObservations: 5,
  promotionMinimumObservations: 10,
  promotionMinimumDurableSuccesses: 5,
  promotionMinimumKnownCosts: 5,
  promotionMinimumVerifiedRate: 0.9,
  demotionRecentWindow: 5,
  demotionMaximumRecentFailureRate: 0.4,
  demotionHealthEvents: 2,
};

export interface StrategyAssessment {
  lifecycle: StrategyLifecycle;
  eligibleAsDefault: boolean;
  observationCount: number;
  verifiedSuccesses: number;
  durableSuccesses: number;
  knownCostCount: number;
  verifiedSuccessRate: number | null;
  averageKnownCostUsd: number | null;
  reasons: string[];
}

const identityKey = (identity: StrategyIdentity): string =>
  JSON.stringify([
    identity.adapter,
    identity.model,
    identity.provider,
    identity.executionMode,
    identity.qualityPreference,
    identity.verificationProfile,
    identity.reviewPolicy,
    identity.baseline,
  ]);

const scopeKey = (scope: StrategyScope): string =>
  JSON.stringify([scope.projectId, scope.taskClass, scope.riskProfile, scope.qualityRequirement]);

const durableTrust = new Set<StrategyObservation["trustState"]>([
  "DURABLE_VERIFIED",
  "MERGE_ELIGIBLE",
]);

/** Opaque counter key: canary allocation is isolated by exact scope and challenger identity. */
export const strategyAllocationKey = (
  scope: StrategyScope,
  challenger: StrategyIdentity,
): string => {
  assertScopeAndIdentity(scope, challenger);
  if (challenger.baseline !== "CHALLENGER")
    throw new Error("Canary allocation requires a challenger identity");
  return `strategy-${createHash("sha256")
    .update(`${scopeKey(scope)}\u0000${identityKey(challenger)}`)
    .digest("hex")}`;
};

const boundedText = (value: string, maximum = 160): boolean =>
  value.length > 0 && value.length <= maximum;
const safeText = (value: string, maximum = 160): boolean =>
  boundedText(value, maximum) && redactSensitiveText(value) === value;
const executionModes = new Set<StrategyIdentity["executionMode"]>([
  "STRICT",
  "GUIDED",
  "SOLO_NATIVE",
  "NATIVE",
]);
const qualityPreferences = new Set<QualityPreference>(["FAST", "BALANCED", "HIGH", "CRITICAL"]);

const assertScopeAndIdentity = (scope: StrategyScope, strategy: StrategyIdentity): void => {
  if (
    !scope ||
    !strategy ||
    !/^project-[a-f0-9]{64}$/u.test(scope.projectId) ||
    !safeText(scope.taskClass) ||
    !safeText(scope.riskProfile) ||
    !qualityPreferences.has(scope.qualityRequirement) ||
    !safeText(strategy.adapter) ||
    !safeText(strategy.model) ||
    !safeText(strategy.provider) ||
    !safeText(strategy.verificationProfile) ||
    !executionModes.has(strategy.executionMode) ||
    !qualityPreferences.has(strategy.qualityPreference) ||
    strategy.qualityPreference !== scope.qualityRequirement ||
    (strategy.reviewPolicy !== "NONE" && strategy.reviewPolicy !== "REQUIRED") ||
    (strategy.baseline !== "NATIVE_FRONTIER" && strategy.baseline !== "CHALLENGER")
  ) {
    throw new Error("Malformed strategy scope or identity cannot authorize execution");
  }
};

export const assertStrategyObservation: (value: unknown) => asserts value is StrategyObservation = (
  value,
) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Malformed strategy observation cannot become promotion evidence");
  const observation = value as StrategyObservation;
  assertScopeAndIdentity(observation.scope, observation.strategy);
  if (
    !boundedText(observation.id) ||
    !Number.isFinite(Date.parse(observation.timestamp)) ||
    new Date(observation.timestamp).toISOString() !== observation.timestamp ||
    (observation.runId !== undefined && !safeText(observation.runId)) ||
    (observation.candidateId !== undefined && !safeText(observation.candidateId)) ||
    (observation.candidateDigest !== undefined &&
      !/^[a-f0-9]{64}$/u.test(observation.candidateDigest)) ||
    typeof observation.verifiedSuccess !== "boolean" ||
    (observation.costUsd !== null &&
      (!Number.isFinite(observation.costUsd) || observation.costUsd < 0)) ||
    !Number.isFinite(observation.latencyMs) ||
    observation.latencyMs < 0 ||
    !Number.isInteger(observation.retries) ||
    observation.retries < 0 ||
    ![
      "PROPOSED",
      "CORRECTNESS_VERIFIED",
      "QUALITY_VERIFIED",
      "DURABLE_VERIFIED",
      "MERGE_ELIGIBLE",
      "NATIVE_VERIFIED",
      "UNKNOWN",
    ].includes(observation.trustState) ||
    !["PASS", "FAIL", "UNKNOWN"].includes(observation.qualityOutcome) ||
    !["PASS", "FAIL", "NOT_CHECKED", "NOT_REQUIRED"].includes(observation.security) ||
    !["PASS", "FAIL", "NOT_CHECKED", "NOT_REQUIRED"].includes(observation.performance) ||
    !["PASS", "FAIL", "NOT_CHECKED", "NOT_REQUIRED"].includes(observation.resilience) ||
    !["STABLE", "DEGRADING", "UNKNOWN"].includes(observation.healthEffect) ||
    !["RUN", "BENCHMARK_SHADOW"].includes(observation.source) ||
    !["RUN_STORE_VERIFIED", "RUN_STORE_TERMINAL", "BENCHMARK_OBSERVED"].includes(
      observation.evidenceBasis,
    )
  ) {
    throw new Error("Malformed strategy observation cannot become promotion evidence");
  }
  if (
    ((observation.evidenceBasis === "RUN_STORE_VERIFIED" ||
      observation.evidenceBasis === "RUN_STORE_TERMINAL") &&
      (observation.source !== "RUN" ||
        observation.runId === undefined ||
        observation.candidateId === undefined ||
        observation.candidateDigest === undefined)) ||
    (observation.evidenceBasis === "BENCHMARK_OBSERVED" &&
      observation.source !== "BENCHMARK_SHADOW")
  ) {
    throw new Error("Strategy evidence source contradicts its evidence basis");
  }
};

const riskDimensionCodes: Array<[keyof RiskVector, string]> = [
  ["ReasoningDifficulty", "RD"],
  ["CodeCoupling", "CC"],
  ["BlastRadius", "BR"],
  ["ArchitectureSensitivity", "AS"],
  ["DebtRisk", "DR"],
  ["SecuritySensitivity", "SS"],
  ["PerformanceSensitivity", "PS"],
  ["OperationalSensitivity", "OS"],
  ["NetworkBoundaryChanges", "NB"],
  ["DataConsistencyRisk", "DC"],
];

const externalOutcome = (state: QualityReport["Security"]["state"]): ExternalCheckOutcome => {
  if (state === "PASS" || state === "FAIL" || state === "NOT_CHECKED" || state === "NOT_REQUIRED")
    return state;
  return "NOT_CHECKED";
};

export interface RunStrategyObservationInput {
  id: string;
  timestamp: string;
  run: Run;
  task: Task;
  projectId: string;
  candidate: Artifact;
  riskVector: RiskVector;
  requiredChecks: string[];
  qualityReport?: QualityReport;
  costKnown: boolean;
  latencyMs: number;
  healthEffect: StrategyObservation["healthEffect"];
}

export const deriveStrategyEvidenceBinding = (
  projectId: string,
  task: Task,
  riskVector: RiskVector,
  requiredChecks: string[],
): NonNullable<Run["strategyEvidenceBinding"]> => ({
  projectId,
  taskClass: `checks:${requiredChecks.toSorted().join("+")}`,
  riskProfile: riskDimensionCodes
    .map(([dimension, code]) => `${code}:${riskVector[dimension].level}`)
    .join("|"),
  qualityRequirement: task.qualityPreference ?? "BALANCED",
  reviewPolicy: requiredChecks.includes("INDEPENDENT_REVIEW") ? "REQUIRED" : "NONE",
});

/** Construct RUN evidence from the trusted service inputs; persistence binds every identity field. */
export const buildRunStrategyObservation = (
  input: RunStrategyObservationInput,
): StrategyObservation => {
  if (!input.candidate.digest) throw new Error("Strategy evidence requires a candidate digest");
  const qualityPreference = input.task.qualityPreference ?? "BALANCED";
  const binding = deriveStrategyEvidenceBinding(
    input.projectId,
    input.task,
    input.riskVector,
    input.requiredChecks,
  );
  const security = input.qualityReport
    ? externalOutcome(input.qualityReport.Security.state)
    : "NOT_CHECKED";
  const performance = input.qualityReport
    ? externalOutcome(input.qualityReport.Performance.state)
    : "NOT_CHECKED";
  const resilience = input.qualityReport
    ? externalOutcome(input.qualityReport.Resilience.state)
    : "NOT_CHECKED";
  const observation: StrategyObservation = {
    id: input.id,
    timestamp: input.timestamp,
    scope: {
      projectId: binding.projectId,
      taskClass: binding.taskClass,
      riskProfile: binding.riskProfile,
      qualityRequirement: binding.qualityRequirement,
    },
    strategy: {
      adapter: input.run.agent,
      model: input.run.model,
      provider: input.run.provider,
      executionMode: input.run.effectiveMode,
      qualityPreference,
      verificationProfile: input.task.verification.command
        ? "COMMAND"
        : input.task.verification.expectedFile
          ? "EXPECTED_FILE"
          : "DEFAULT",
      reviewPolicy: binding.reviewPolicy,
      baseline: "CHALLENGER",
    },
    runId: input.run.id,
    candidateId: input.candidate.id,
    candidateDigest: input.candidate.digest,
    verifiedSuccess: input.run.verificationState === "VERIFIED",
    trustState: input.run.trustState ?? "UNKNOWN",
    costUsd: input.costKnown ? input.run.cost.total : null,
    latencyMs: input.latencyMs,
    retries: input.run.retryCount,
    qualityOutcome: !input.qualityReport
      ? "FAIL"
      : input.run.trustState === "QUALITY_VERIFIED" ||
          input.run.trustState === "DURABLE_VERIFIED" ||
          input.run.trustState === "MERGE_ELIGIBLE"
        ? "PASS"
        : Object.values(input.qualityReport).some((result) => result.state === "FAIL")
          ? "FAIL"
          : "UNKNOWN",
    security,
    performance,
    resilience,
    healthEffect: input.healthEffect,
    source: "RUN",
    evidenceBasis:
      input.run.verificationState === "VERIFIED" ? "RUN_STORE_VERIFIED" : "RUN_STORE_TERMINAL",
  };
  assertStrategyObservation(observation);
  return observation;
};

export const strategyObservationBinding = (
  observation: StrategyObservation,
): StrategyObservationBinding => {
  assertStrategyObservation(observation);
  if (observation.evidenceBasis === "BENCHMARK_OBSERVED")
    throw new Error("Benchmark observations cannot become durable run bindings");
  return {
    id: observation.id,
    timestamp: observation.timestamp,
    verifiedSuccess: observation.verifiedSuccess,
    costUsd: observation.costUsd,
    latencyMs: observation.latencyMs,
    retries: observation.retries,
    qualityOutcome: observation.qualityOutcome,
    security: observation.security,
    performance: observation.performance,
    resilience: observation.resilience,
    healthEffect: observation.healthEffect,
    evidenceBasis: observation.evidenceBasis,
  };
};

export const assessStrategy = (
  scope: StrategyScope,
  strategy: StrategyIdentity,
  allObservations: StrategyObservation[],
  policy: StrategyPolicy = defaultStrategyPolicy,
): StrategyAssessment => {
  assertScopeAndIdentity(scope, strategy);
  if (strategy.baseline !== "CHALLENGER")
    throw new Error("Strategy assessment requires an explicit challenger identity");
  const scoped = allObservations
    .filter(
      (observation) =>
        scopeKey(observation.scope) === scopeKey(scope) &&
        identityKey(observation.strategy) === identityKey(strategy),
    )
    .toSorted(
      (left, right) =>
        Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id),
    );
  const observations: StrategyObservation[] = [];
  const seenIds = new Set<string>();
  const seenCandidates = new Set<string>();
  for (const observation of scoped) {
    assertStrategyObservation(observation);
    const candidateKey =
      observation.runId && observation.candidateId
        ? `${observation.runId}\u0000${observation.candidateId}`
        : undefined;
    if (seenIds.has(observation.id) || (candidateKey && seenCandidates.has(candidateKey))) continue;
    seenIds.add(observation.id);
    if (candidateKey) seenCandidates.add(candidateKey);
    observations.push(observation);
  }
  const verified = observations.filter((observation) => observation.verifiedSuccess);
  const durable = verified.filter(
    (observation) =>
      durableTrust.has(observation.trustState) &&
      observation.evidenceBasis === "RUN_STORE_VERIFIED" &&
      observation.candidateId !== undefined &&
      observation.runId !== undefined &&
      observation.candidateDigest !== undefined,
  );
  const knownCosts = observations.flatMap((observation) =>
    observation.costUsd === null ? [] : [observation.costUsd],
  );
  const verifiedSuccessRate =
    observations.length === 0 ? null : verified.length / observations.length;
  const averageKnownCostUsd =
    knownCosts.length === 0
      ? null
      : knownCosts.reduce((total, cost) => total + cost, 0) / knownCosts.length;
  const reasons: string[] = [];

  if (observations.length === 0) {
    return {
      lifecycle: "SHADOW",
      eligibleAsDefault: false,
      observationCount: 0,
      verifiedSuccesses: 0,
      durableSuccesses: 0,
      knownCostCount: 0,
      verifiedSuccessRate: null,
      averageKnownCostUsd: null,
      reasons: ["no scoped evidence; challenger remains shadow-only"],
    };
  }

  const recent = observations.slice(-policy.demotionRecentWindow);
  const recentFailureRate =
    recent.filter((observation) => !observation.verifiedSuccess).length / recent.length;
  const assuranceFailure = observations.some(
    (observation) =>
      observation.security === "FAIL" ||
      observation.performance === "FAIL" ||
      observation.resilience === "FAIL",
  );
  const qualityFailures = observations.filter(
    (observation) => observation.qualityOutcome === "FAIL",
  ).length;
  const degradingHealth = observations.filter(
    (observation) => observation.healthEffect === "DEGRADING",
  ).length;
  if (
    assuranceFailure ||
    qualityFailures >= 2 ||
    (recent.length === policy.demotionRecentWindow &&
      recentFailureRate > policy.demotionMaximumRecentFailureRate) ||
    degradingHealth >= policy.demotionHealthEvents
  ) {
    if (assuranceFailure) reasons.push("a scoped security/performance/resilience check failed");
    if (qualityFailures >= 2) reasons.push(`${qualityFailures} scoped quality outcomes failed`);
    if (recentFailureRate > policy.demotionMaximumRecentFailureRate)
      reasons.push(`recent verified failure rate is ${recentFailureRate}`);
    if (degradingHealth >= policy.demotionHealthEvents)
      reasons.push(`${degradingHealth} scoped observations report degrading health effects`);
    return {
      lifecycle: "DEMOTED",
      eligibleAsDefault: false,
      observationCount: observations.length,
      verifiedSuccesses: verified.length,
      durableSuccesses: durable.length,
      knownCostCount: knownCosts.length,
      verifiedSuccessRate,
      averageKnownCostUsd,
      reasons,
    };
  }

  const criticalChecksKnown =
    scope.qualityRequirement !== "CRITICAL" ||
    observations.every(
      (observation) =>
        observation.security === "PASS" &&
        (observation.performance === "PASS" || observation.performance === "NOT_REQUIRED") &&
        (observation.resilience === "PASS" || observation.resilience === "NOT_REQUIRED"),
    );
  const promotionGaps = [
    observations.length < policy.promotionMinimumObservations
      ? `needs ${policy.promotionMinimumObservations} observations; has ${observations.length}`
      : undefined,
    durable.length < policy.promotionMinimumDurableSuccesses
      ? `needs ${policy.promotionMinimumDurableSuccesses} candidate-bound durable successes; has ${durable.length}`
      : undefined,
    knownCosts.length < policy.promotionMinimumKnownCosts
      ? `needs ${policy.promotionMinimumKnownCosts} known cost observations; unknown cost is not free`
      : undefined,
    (verifiedSuccessRate ?? 0) < policy.promotionMinimumVerifiedRate
      ? `verified success rate ${verifiedSuccessRate ?? 0} is below ${policy.promotionMinimumVerifiedRate}`
      : undefined,
    !criticalChecksKnown
      ? "critical assurance outcomes are not acceptable verified results"
      : undefined,
  ].filter((reason): reason is string => reason !== undefined);

  if (promotionGaps.length === 0) {
    return {
      lifecycle: "PROMOTED",
      eligibleAsDefault: true,
      observationCount: observations.length,
      verifiedSuccesses: verified.length,
      durableSuccesses: durable.length,
      knownCostCount: knownCosts.length,
      verifiedSuccessRate,
      averageKnownCostUsd,
      reasons: ["scoped promotion thresholds are satisfied"],
    };
  }
  const canary =
    observations.length >= policy.canaryMinimumObservations &&
    verified.length / observations.length >= 0.8;
  return {
    lifecycle: canary ? "CANARY" : "SHADOW",
    eligibleAsDefault: false,
    observationCount: observations.length,
    verifiedSuccesses: verified.length,
    durableSuccesses: durable.length,
    knownCostCount: knownCosts.length,
    verifiedSuccessRate,
    averageKnownCostUsd,
    reasons: promotionGaps,
  };
};

export interface StrategySelection {
  selected: StrategyIdentity;
  challenger: StrategyAssessment;
  reason: string;
}

/** Native frontier is always a valid fallback; canary use is deterministic and bounded. */
export const selectStrategy = (
  scope: StrategyScope,
  nativeFrontier: StrategyIdentity,
  challenger: StrategyIdentity,
  observations: StrategyObservation[],
  canaryOrdinal: number,
  policy: StrategyPolicy = defaultStrategyPolicy,
): StrategySelection => {
  assertScopeAndIdentity(scope, nativeFrontier);
  if (nativeFrontier.baseline !== "NATIVE_FRONTIER")
    throw new Error("Strategy selection requires an explicit native-frontier baseline");
  if (nativeFrontier.executionMode !== "NATIVE" || challenger.baseline !== "CHALLENGER")
    throw new Error("Strategy selection requires native-frontier and challenger roles");
  if (!Number.isInteger(canaryOrdinal) || canaryOrdinal < 0)
    throw new Error("Strategy selection requires a non-negative integer canary ordinal");
  const assessment = assessStrategy(scope, challenger, observations, policy);
  if (assessment.lifecycle === "PROMOTED")
    return {
      selected: challenger,
      challenger: assessment,
      reason: "scoped challenger is promoted",
    };
  const securityCritical = scope.qualityRequirement === "CRITICAL";
  if (assessment.lifecycle === "CANARY" && !securityCritical && canaryOrdinal % 10 === 0) {
    return {
      selected: challenger,
      challenger: assessment,
      reason: "bounded 10% canary slot for a scoped challenger",
    };
  }
  return {
    selected: nativeFrontier,
    challenger: assessment,
    reason: securityCritical
      ? "unpromoted challenger cannot displace native frontier for a critical task"
      : "native frontier remains the safe baseline",
  };
};
