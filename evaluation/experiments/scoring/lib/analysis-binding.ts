// Binds the scoring runner to the FROZEN Analysis v1 specification.
//
// This module deliberately contains no statistics. Every aggregation rule, the McNemar variant and
// the paired difference interval live in `evaluation/experiments/analysis/analysis-v1.ts`, frozen
// at tag `maf-experiment-analysis-v1`. Re-deriving any of them here -- even identically -- would
// create a second implementation that could drift from the frozen one, and the whole point of
// freezing the analysis before scoring is that exactly one specification governs the numbers.
//
// So the job here is narrow and boring on purpose: turn durable scoring observations into the
// Observation shape Analysis v1 accepts, call it, and attach the analysis identity to the result.
//
// `scoring/lib/statistics.ts` is NOT used for analysis any more. It remains in the tree as the
// record of the three ambiguities the readiness audit found, which is what motivated Analysis v1;
// its `analyzeScoringRuns` is superseded and must not be wired into a campaign.

import {
  ANALYSIS_STATUS,
  ANALYSIS_TAG,
  ANALYSIS_VERSION,
  analyzeExperimentV1,
  type AnalysisV1Report,
  type Observation,
} from "../../analysis/analysis-v1";
import { ANALYSIS_SHA } from "./frozen-refs";
import { NON_SCORING_TASK_IDS } from "./scoring-provenance";
import type { ObservationRecord, SlotState } from "./state-store";

export interface AnalysisIdentity {
  analysisTag: string;
  analysisSha: string;
  analysisVersion: string;
  analysisStatus: string;
}

export const ANALYSIS_IDENTITY: AnalysisIdentity = {
  analysisTag: ANALYSIS_TAG,
  analysisSha: ANALYSIS_SHA,
  analysisVersion: ANALYSIS_VERSION,
  analysisStatus: ANALYSIS_STATUS,
};

export interface BoundAnalysisReport extends AnalysisV1Report {
  analysisSha: string;
  analysisStatus: string;
  /** Observations excluded before analysis, with the reason, so nothing vanishes silently. */
  excludedObservations: Array<{ taskId: string; reason: string }>;
}

/**
 * Selects the observation each slot is analysed under.
 *
 * A slot may hold several observations when the protocol authorized an infrastructure rerun
 * (17.2: the rerun REPLACES the failed slot rather than adding to N). The latest is therefore the
 * one analysed, and the superseded ones stay on disk as preserved evidence. Taking anything other
 * than the latest would either double-count a task-arm cell or analyse a run the protocol says was
 * replaced.
 */
export const authoritativeObservation = (state: SlotState): ObservationRecord | null =>
  state.observations.length === 0
    ? null
    : (state.observations[state.observations.length - 1] as ObservationRecord);

/**
 * Converts durable slot state into Analysis v1 observations.
 *
 * Two exclusions are applied, both structural rather than statistical:
 *   * NON_SCORING material (the preflight fixture) can never enter the experiment.
 *   * A task outside the frozen suite can never enter the experiment.
 * Neither is a judgement about a result; both are membership facts, and both are recorded.
 */
export const toAnalysisObservations = (
  states: readonly SlotState[],
  frozenTaskIds: readonly string[],
): { observations: Observation[]; excluded: Array<{ taskId: string; reason: string }> } => {
  const observations: Observation[] = [];
  const excluded: Array<{ taskId: string; reason: string }> = [];

  for (const state of states) {
    const record = authoritativeObservation(state);
    if (!record) continue;
    if (NON_SCORING_TASK_IDS.includes(record.taskId)) {
      excluded.push({
        taskId: record.taskId,
        reason: "NON_SCORING fixture (NOT_PART_OF_EXPERIMENT) can never enter scoring statistics",
      });
      continue;
    }
    if (!frozenTaskIds.includes(record.taskId)) {
      excluded.push({
        taskId: record.taskId,
        reason: "task is not a member of the frozen 29-task suite",
      });
      continue;
    }
    observations.push({
      taskId: record.taskId,
      arm: record.arm,
      replicate: record.replicate,
      // Analysis v1 requires validity and DVS only. An invalid run is passed through AS invalid; it
      // is never converted to dvs=false, which is what "no imputation" means in practice.
      runValidity: record.runValidity,
      dvs: record.dvs,
    });
  }
  return { observations, excluded };
};

export interface RunAnalysisInput {
  states: readonly SlotState[];
  frozenTaskIds: readonly string[];
  taskIds: readonly string[];
  runsPerTask: number;
  expectedSlots: number;
  allowFinal?: boolean;
}

/** Runs the frozen Analysis v1 specification over the campaign's durable observations. */
export const runFrozenAnalysis = (input: RunAnalysisInput): BoundAnalysisReport => {
  const { observations, excluded } = toAnalysisObservations(input.states, input.frozenTaskIds);
  const report = analyzeExperimentV1({
    observations,
    taskIds: input.taskIds,
    runsPerTask: input.runsPerTask,
    expectedSlots: input.expectedSlots,
    ...(input.allowFinal !== undefined ? { allowFinal: input.allowFinal } : {}),
  });
  return {
    ...report,
    analysisSha: ANALYSIS_SHA,
    analysisStatus: ANALYSIS_STATUS,
    excludedObservations: excluded,
  };
};
