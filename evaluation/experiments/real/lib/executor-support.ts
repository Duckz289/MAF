// Shared configuration and side-channel assembly for both experiment arms.
//
// Keeping this in one place is a confound-avoidance measure as much as a DRY one: in a paired
// experiment, any asymmetry between how the two arms compute their own cost, ceilings or provenance
// becomes an artifact of the harness rather than of the treatment.

import type { AgentAdapter } from "../../../../src/domain/ports";
import type { AttemptDriverResult } from "./attempt-driver";
import type { BudgetGuard } from "./budget-guard";
import type { RunExecutionLedger } from "./run-ledger";
import type { CostBreakdown, ExecutorSideChannel, MafInterventionRecord } from "./provenance";

export interface ExperimentExecutorConfig {
  requestedModel: string;
  effort: string;
  provider: string;
  /** Run-level deadline. Shared across every attempt, never reset by a retry. */
  timeoutMs: number;
  /** Run-level budget. Shared across every attempt, never reset by a retry. */
  budgetUsd: number;
  /** Hard ceiling on provider invocations for this run, enforced before any spawn. */
  maxProviderInvocations?: number;
  maxRecoveryAttempts?: number;
  /** Below this remaining run budget a further billed attempt is refused. Production default in
   *  run-ledger.ts; overridable so tests can drive the thresholds deterministically. */
  minimumAttemptBudgetUsd?: number;
  /** Below this remaining run time a further attempt is refused. */
  minimumAttemptTimeMs?: number;
  /** Explicit Claude Code executable path. Resolved once by the preflight gate and reused, so the
   *  binary that was auth-checked is provably the binary that runs. */
  claudeCommand?: string;
  /** Test-only injection point. Every default is the real production component. */
  adapter?: AgentAdapter;
}

/**
 * Assembles run cost from EVERY attempt.
 *
 * `participantCostUsd` is the sum over all attempts, not the final attempt's figure: a failed
 * attempt's spend is real money and never disappears because a later attempt succeeded.
 * `orchestrationCostUsd` is 0 because MAF's signal collection and mode decisions run locally and
 * call no model of their own -- genuinely zero, and asserted as such by the caller rather than
 * assumed. UNKNOWN is never coerced to 0.
 */
const buildCost = (
  totals: AttemptDriverResult["totals"],
  orchestrationCostUsd: number,
): CostBreakdown => {
  const costKnown = totals.costStatus === "KNOWN";
  const anyKnown = totals.attemptsWithKnownCost > 0;
  const participantCostUsd = anyKnown ? totals.knownCostUsd : null;
  const totalCostUsd =
    participantCostUsd === null ? null : participantCostUsd + orchestrationCostUsd;
  const note = costKnown
    ? undefined
    : anyKnown
      ? `${totals.attemptsWithUnknownCost} of ${
          totals.attemptsWithKnownCost + totals.attemptsWithUnknownCost
        } attempt(s) never reported a cost; the figures below are a LOWER BOUND covering only the ` +
        "attempts that did, not a complete run cost"
      : "no attempt ever reported a cost; token counts are 0 because none were observed, not " +
        "because zero usage was confirmed";

  return {
    participantCostUsd,
    participantInputTokens: totals.inputTokens,
    participantOutputTokens: totals.outputTokens,
    participantCacheTokens: totals.cachedTokens,
    orchestrationCostUsd,
    // Controller-side grading/regression runs locally and calls no model: genuinely zero.
    verificationCostUsd: 0,
    totalCostUsd,
    costStatus: totals.costStatus,
    ...(note ? { note } : {}),
  };
};

export const buildSideChannel = (input: {
  config: ExperimentExecutorConfig;
  driven: AttemptDriverResult;
  ledger: RunExecutionLedger;
  budgetGuard: BudgetGuard;
  effortArgumentEmitted: boolean;
  candidateWorkspace: string;
  orchestrationCostUsd?: number;
  maf?: MafInterventionRecord;
}): ExecutorSideChannel => {
  const { config, driven, ledger } = input;
  const cost = buildCost(driven.totals, input.orchestrationCostUsd ?? 0);
  const completed = driven.finalOutcome.classification === "COMPLETED";
  return {
    requestedModel: config.requestedModel,
    resolvedModel: driven.modelProvenance.resolvedModel,
    resolvedModelStatus: driven.modelProvenance.resolvedModelStatus,
    rawReportedModel: driven.modelProvenance.rawReportedModel,
    modelProvenanceNote: driven.modelProvenance.note,
    effort: config.effort,
    effortArgumentEmitted: input.effortArgumentEmitted,
    provider: config.provider,
    startedAt: driven.startedAt,
    finishedAt: driven.finishedAt,
    timeout: {
      timeoutMs: config.timeoutMs,
      timedOut: driven.finalOutcome.classification === "TIMEOUT",
    },
    // The post-hoc budget comparison uses the RUN total across attempts, not one attempt's figure.
    budget: input.budgetGuard.finalize(cost.participantCostUsd),
    cost,
    candidateWorkspace: input.candidateWorkspace,
    attempts: driven.attempts,
    ceilings: {
      runTimeoutMs: config.timeoutMs,
      runDeadline: new Date(ledger.runDeadlineMs).toISOString(),
      remainingRunTimeMsAtEnd: ledger.remainingRunTimeMs(),
      runBudgetUsd: config.budgetUsd,
      remainingRunBudgetUsdAtEnd: ledger.remainingRunBudgetUsd(),
      providerInvocationsAllowed: ledger.maxProviderInvocations,
      providerInvocationsStarted: ledger.providerInvocationsStarted,
      providerInvocationsRefused: ledger.providerInvocationsRefused,
    },
    firstFailure: completed ? null : driven.finalOutcome.firstFailure,
    failureClassification: driven.finalOutcome.classification,
    ...(input.maf ? { maf: input.maf } : {}),
  };
};
