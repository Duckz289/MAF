// Scoring-run provenance: the frozen Protocol v2 record, plus the identity a SCORING observation
// needs that a one-off preflight did not.
//
// Three additions over `ExperimentProvenanceRecord`, each closing a specific audit finding:
//
//   1. Runner identity (runnerTag/runnerSha/runnerVersion). A scoring result is only reproducible if
//      you know which runner produced it. Protocol and suite identity alone do not pin the executing
//      artifact.
//   2. Deterministic slot identity (slotId/slotDigest/replicate/sequencePosition). The preflight used
//      a random UUID, which cannot answer "does this observation already exist?".
//   3. Starting-state identity (sourceRevision). The preflight recorded UNKNOWN even though the
//      starting state was fully determined.
//
// This module also holds the structural guarantee that NON_SCORING material can never reach a
// scoring aggregate.

import type { ExperimentProvenanceRecord } from "../../real/lib/provenance";
import type { Arm } from "./schedule";
import type { SourceRevisionIdentity } from "./source-revision";

/** Task ids that exist for plumbing verification and are never part of the experiment. */
export const NON_SCORING_TASK_IDS: readonly string[] = ["preflight-task", "dry-run-phase"];

export interface RunnerIdentity {
  runnerVersion: string;
  runnerTag: string;
  /** Null only while the runner is unfrozen -- a state in which scoring cannot execute at all. */
  runnerSha: string | null;
}

export interface ScoringSlotIdentity {
  slotId: string;
  slotDigest: string;
  taskId: string;
  arm: Arm;
  replicate: number;
  randomizationPosition: number;
  sequencePosition: number;
  generation: number;
  attemptId: string;
}

export interface ScoringProvenanceRecord extends ExperimentProvenanceRecord {
  /** Always SCORING here; NON_SCORING material is rejected by `assertScoringEligible`. */
  scoringStatus: "SCORING";
  runner: RunnerIdentity;
  slot: ScoringSlotIdentity;
  sourceRevision: SourceRevisionIdentity;
  /** Freeze authority, recorded because the frozen source's own metadata predates the tag. */
  protocolFreezeAuthority: "GIT_TAG";
  protocolFrozen: true;
  knownSourceMetadataNote: string;
  /** Durable crash/recovery state this observation was finalized from. */
  recoveryState: "CLEAN" | "RESUMED_AFTER_SAFE_RECLAIM" | "ADJUDICATED";
}

export interface ProvenanceCompleteness {
  complete: boolean;
  missing: string[];
}

/**
 * Verifies every field the mission's Phase 16 schema requires is actually populated.
 *
 * Presence is checked rather than plausibility: a schema that permits `undefined` silently produces
 * reports whose gaps are invisible. `null` is accepted only where null is itself meaningful (an
 * unmeasured cost, an unresolved model identity) and is rejected where it would be a hole.
 */
export const checkProvenanceCompleteness = (
  record: Partial<ScoringProvenanceRecord>,
): ProvenanceCompleteness => {
  const missing: string[] = [];
  const require = (condition: boolean, field: string): void => {
    if (!condition) missing.push(field);
  };
  const str = (value: unknown): boolean => typeof value === "string" && value.length > 0;
  const num = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

  require(str(record.suiteTag), "suiteTag");
  require(str(record.suiteSha), "suiteSha");
  require(str(record.protocolTag), "protocolTag");
  require(str(record.protocolSha), "protocolSha");
  require(str(record.runner?.runnerTag), "runner.runnerTag");
  require(str(record.runner?.runnerVersion), "runner.runnerVersion");
  require(record.runner?.runnerSha !== undefined, "runner.runnerSha");
  require(str(record.slot?.slotId), "slot.slotId");
  require(str(record.slot?.slotDigest), "slot.slotDigest");
  require(str(record.slot?.attemptId), "slot.attemptId");
  require(str(record.taskId), "taskId");
  require(record.arm === "NATIVE" || record.arm === "MAF", "arm");
  require(num(record.slot?.replicate), "slot.replicate");
  require(num(record.slot?.randomizationPosition), "slot.randomizationPosition");
  require(num(record.slot?.sequencePosition), "slot.sequencePosition");
  require(str(record.requestedModel), "requestedModel");
  require(record.rawReportedModel !== undefined, "rawReportedModel");
  require(record.resolvedModel !== undefined, "resolvedModel");
  require(str(record.resolvedModelStatus), "resolvedModelStatus");
  require(str(record.effort), "effort");
  require(typeof record.effortArgumentEmitted === "boolean", "effortArgumentEmitted");
  require(num(record.ceilings?.providerInvocationsAllowed), "ceilings.providerInvocationsAllowed");
  require(num(record.ceilings?.providerInvocationsStarted), "ceilings.providerInvocationsStarted");
  require(num(record.ceilings?.providerInvocationsRefused), "ceilings.providerInvocationsRefused");
  require(str(record.startedAt), "startedAt");
  require(str(record.finishedAt), "finishedAt");
  require(num(record.durationMs), "durationMs");
  require(num(record.timeoutMs), "timeoutMs");
  require(typeof record.timedOut === "boolean", "timedOut");
  require(num(record.budgetUsd), "budgetUsd");
  require(record.usage !== undefined, "usage");
  require(record.cost !== undefined, "cost");
  require(str(record.cost?.costStatus), "cost.costStatus");
  require(str(record.sourceRevision?.contentDigest), "sourceRevision.contentDigest");
  require(record.sourceRevision?.seedCommitSha !== undefined, "sourceRevision.seedCommitSha");
  require(str(record.candidateIntegrity), "candidateIntegrity");
  require(str(record.hiddenGrader), "hiddenGrader");
  require(str(record.regression), "regression");
  require(record.regressionEvidence !== undefined, "regressionEvidence");
  require(str(record.failureClassification), "failureClassification");
  require(str(record.runValidity), "runValidity");
  require(typeof record.dvs === "boolean", "dvs");
  require(str(record.recoveryState), "recoveryState");
  require(Array.isArray(record.attempts), "attempts");
  require(record.protocolFreezeAuthority === "GIT_TAG", "protocolFreezeAuthority");

  return { complete: missing.length === 0, missing };
};

/**
 * Refuses to let non-experiment material become a scoring observation.
 *
 * Checked BOTH ways on purpose. The task id must be one of the frozen 29 (so nothing outside the
 * suite can be scored), and it must not be a known non-scoring fixture id (so a fixture that was
 * ever mistakenly added to the suite still cannot slip through). Either check alone would leave a
 * gap the other closes.
 */
export const assertScoringEligible = (input: {
  taskId: string;
  scoringStatus: string;
  frozenTaskIds: readonly string[];
}): void => {
  if (input.scoringStatus !== "SCORING") {
    throw new Error(
      `refusing to record a scoring observation with scoringStatus="${input.scoringStatus}"; ` +
        "only SCORING records may enter the campaign",
    );
  }
  if (NON_SCORING_TASK_IDS.includes(input.taskId)) {
    throw new Error(
      `task "${input.taskId}" is a NON_SCORING fixture (NOT_PART_OF_EXPERIMENT) and can never ` +
        "enter scoring statistics, the DVS denominator, cost-per-DVS, McNemar or the Wilson interval",
    );
  }
  if (!input.frozenTaskIds.includes(input.taskId)) {
    throw new Error(
      `task "${input.taskId}" is not a member of the frozen 29-task suite; only frozen suite tasks ` +
        "may produce scoring observations",
    );
  }
};

/** Filters any record collection down to genuine scoring material. Used before every aggregate. */
export const excludeNonScoring = <T extends { taskId: string; scoringStatus?: string }>(
  records: readonly T[],
  frozenTaskIds: readonly string[],
): T[] =>
  records.filter(
    (record) =>
      record.scoringStatus !== "NON_SCORING" &&
      !NON_SCORING_TASK_IDS.includes(record.taskId) &&
      frozenTaskIds.includes(record.taskId),
  );
