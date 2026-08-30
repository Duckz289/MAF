import { deterministicDigest } from "./deterministic-identity";
import type { CanonicalCostRecord } from "./model-intelligence";
import type { TrustState } from "./types";

export type ChallengerClass =
  | "PROMPT"
  | "SKILL"
  | "CONTEXT_POLICY"
  | "MODEL_ROUTING_POLICY"
  | "STRATEGY_POLICY"
  | "ASSURANCE_SCHEDULING_POLICY";

export type ChallengerLifecycle =
  | "CANDIDATE"
  | "OFFLINE_EVALUATED"
  | "REGRESSION_VERIFIED"
  | "HOLDOUT_EVALUATED"
  | "SHADOW"
  | "PROMOTED"
  | "REJECTED"
  | "REVOKED";

export interface OptimizableArtifactIdentity {
  class: ChallengerClass;
  id: string;
  version: string;
  digest: string;
}

export interface FrozenEvaluationSuite {
  id: string;
  version: string;
  digest: string;
  frozen: true;
}

export interface EvaluationMetrics {
  taskSuccess: boolean | null;
  verificationPassed: boolean | null;
  durableVerifiedSuccess: boolean | null;
  hiddenRegressionPassed: boolean | null;
  cost: CanonicalCostRecord | null;
  contextCharacters: number | null;
  latencyMs: number | null;
  retries: number | null;
  humanInterventionCount: number | null;
}

export interface EvaluationRecord {
  schemaVersion: 1;
  id: string;
  candidate: OptimizableArtifactIdentity;
  baseline: OptimizableArtifactIdentity;
  suite: FrozenEvaluationSuite;
  stage: "OFFLINE_REPLAY" | "REGRESSION" | "FROZEN_HOLDOUT" | "SHADOW";
  result: "PASS" | "FAIL" | "UNKNOWN";
  promotionStatus: "NOT_DECIDED";
  metrics: EvaluationMetrics;
  trustAuthority: "NONE";
  evidenceRefs: string[];
}

export interface EvolutionCandidate {
  identity: OptimizableArtifactIdentity;
  baseline: OptimizableArtifactIdentity;
  lifecycle: ChallengerLifecycle;
  constitutionDigest: string;
  evaluationIds: string[];
  promotionDecision: null | {
    authority: "MAF_POLICY";
    decision: "PROMOTED" | "REJECTED";
    evidenceIds: string[];
  };
}

/** Generic optional offline/shadow adapter seam; no external evaluator is a trust authority. */
export interface EvolutionEvaluationPort {
  evaluate(input: {
    candidate: OptimizableArtifactIdentity;
    baseline: OptimizableArtifactIdentity;
    suite: FrozenEvaluationSuite;
    stage: EvaluationRecord["stage"];
  }): Promise<Omit<EvaluationRecord, "schemaVersion" | "id" | "trustAuthority">>;
}

const digestPattern = /^[a-f0-9]{64}$/u;

export const frozenSuite = (input: {
  id: string;
  version: string;
  datasetIdentity: unknown;
}): FrozenEvaluationSuite => ({
  id: input.id,
  version: input.version,
  digest: deterministicDigest(input.datasetIdentity),
  frozen: true,
});

export const createEvaluationRecord = (
  input: Omit<EvaluationRecord, "schemaVersion" | "id" | "trustAuthority" | "promotionStatus">,
): EvaluationRecord => {
  if (
    !digestPattern.test(input.candidate.digest) ||
    !digestPattern.test(input.baseline.digest) ||
    !digestPattern.test(input.suite.digest) ||
    input.candidate.class !== input.baseline.class
  ) {
    throw new Error("Evaluation identities must be digest-bound and class-compatible");
  }
  const identity = {
    candidate: input.candidate,
    baseline: input.baseline,
    suite: input.suite,
    stage: input.stage,
    result: input.result,
    promotionStatus: "NOT_DECIDED" as const,
    metrics: input.metrics,
    evidenceRefs: input.evidenceRefs,
  };
  return {
    schemaVersion: 1,
    id: `evaluation-${deterministicDigest(identity)}`,
    ...structuredClone(input),
    promotionStatus: "NOT_DECIDED",
    trustAuthority: "NONE",
  };
};

export const createEvolutionCandidate = (input: {
  identity: OptimizableArtifactIdentity;
  baseline: OptimizableArtifactIdentity;
  constitutionDigest: string;
}): EvolutionCandidate => {
  if (
    input.identity.class !== input.baseline.class ||
    !digestPattern.test(input.identity.digest) ||
    !digestPattern.test(input.baseline.digest) ||
    !digestPattern.test(input.constitutionDigest)
  ) {
    throw new Error("A challenger must bind its class, baseline, and immutable constitution");
  }
  return {
    identity: structuredClone(input.identity),
    baseline: structuredClone(input.baseline),
    lifecycle: "CANDIDATE",
    constitutionDigest: input.constitutionDigest,
    evaluationIds: [],
    promotionDecision: null,
  };
};

export const decidePromotion = (input: {
  candidate: EvolutionCandidate;
  evaluations: EvaluationRecord[];
  suite: FrozenEvaluationSuite;
  authority: "MAF_POLICY" | "CANDIDATE_REPORT" | "EXTERNAL_EVALUATOR";
  decision: "PROMOTED" | "REJECTED";
}): EvolutionCandidate => {
  if (input.authority !== "MAF_POLICY") {
    throw new Error("A challenger or evaluator cannot self-promote; only MAF policy may decide");
  }
  const applicable = input.evaluations.filter(
    (record) =>
      record.candidate.digest === input.candidate.identity.digest &&
      record.baseline.digest === input.candidate.baseline.digest &&
      record.suite.id === input.suite.id &&
      record.suite.version === input.suite.version &&
      record.suite.digest === input.suite.digest &&
      record.suite.frozen &&
      input.suite.frozen,
  );
  if (input.decision === "PROMOTED") {
    const regression = applicable.some(
      (record) => record.stage === "REGRESSION" && record.result === "PASS",
    );
    const holdout = applicable.some(
      (record) =>
        record.stage === "FROZEN_HOLDOUT" && record.result === "PASS" && record.suite.frozen,
    );
    const shadow = applicable.some(
      (record) => record.stage === "SHADOW" && record.result === "PASS",
    );
    if (!regression || !holdout || !shadow) {
      throw new Error("Promotion requires passing regression, frozen holdout, and shadow evidence");
    }
  }
  return {
    ...structuredClone(input.candidate),
    lifecycle: input.decision,
    evaluationIds: applicable.map((record) => record.id),
    promotionDecision: {
      authority: "MAF_POLICY",
      decision: input.decision,
      evidenceIds: applicable.map((record) => record.id),
    },
  };
};

/** Evaluation outcomes describe challengers; they never project into candidate trust semantics. */
export const evaluationTrustProjection = (_record: EvaluationRecord): TrustState | null => null;
