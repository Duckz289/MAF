// Shared attempt-execution loop for both experiment arms.
//
// Both the Native and MAF executors need exactly the same run-level guarantees: a hard provider
// invocation ceiling checked BEFORE any spawn, per-attempt ceilings derived from what remains of the
// run's budget and deadline, cost aggregated across every attempt, and full attempt-level
// provenance. Putting that in one place is what makes it impossible for one arm to quietly diverge
// from the other -- a real risk in a paired experiment where any asymmetry becomes a confound.

import type { AgentAdapter, AgentStartInput } from "../../../../src/domain/ports";
import type { AgentEvent } from "../../../../src/domain/types";
import { classifyModelProvenance, type ModelProvenance } from "./diagnostics";
import { runAgentSession, type AgentSessionResult } from "./agent-session-runner";
import type { RunExecutionLedger } from "./run-ledger";
import { isAutoRetryableAttempt, type AttemptOutcome } from "./session-outcome";
import type { AttemptRecord, CostFieldStatus } from "./provenance";

export interface AttemptDriverConfig {
  requestedModel: string;
  effort: string;
  /** True when the underlying adapter actually forwards `--effort` (i.e. the real ClaudeCodeAdapter). */
  effortArgumentEmitted: boolean;
  /**
   * How many auto-retries the run may attempt on top of the first invocation. The billed synthetic
   * preflight passes 0: one authorization means exactly one provider invocation, enforced before
   * spawn rather than reported after the fact.
   */
  maxRecoveryAttempts: number;
  /** Adapter-level per-attempt budget setter, so each retry gets only the REMAINING run budget. */
  applyAttemptBudget?: (attemptBudgetUsd: number) => void;
}

export interface AttemptDriverResult {
  /** The attempt whose outcome the run is reported as. The last one actually started. */
  finalSession: AgentSessionResult | null;
  finalOutcome: AttemptOutcome;
  attempts: AttemptRecord[];
  modelProvenance: ModelProvenance;
  retries: number;
  totals: ReturnType<RunExecutionLedger["totals"]>;
  startedAt: string;
  finishedAt: string;
}

const costStatusForAttempt = (costUsd: number | null): CostFieldStatus =>
  costUsd === null ? "UNKNOWN" : "KNOWN";

/**
 * Runs one experiment run's attempts under the ledger's ceilings.
 *
 * Retry happens only when the attempt's STRUCTURED classification is auto-retryable
 * (PROVIDER_FAILURE alone -- see session-outcome.ts), never because a synthesized message happened
 * to match a text pattern. Every retry is additionally gated by `ledger.beginAttempt()`, which
 * refuses before spawn when the invocation ceiling, the run deadline or the run budget is exhausted,
 * or when a prior attempt's cost was unmeasured.
 */
export const driveAttempts = async (params: {
  adapter: AgentAdapter;
  input: AgentStartInput;
  prompt: string;
  ledger: RunExecutionLedger;
  config: AttemptDriverConfig;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AttemptDriverResult> => {
  const { ledger, config } = params;
  const attempts: AttemptRecord[] = [];
  const startedAt = new Date().toISOString();
  let finalSession: AgentSessionResult | null = null;
  let finalOutcome: AttemptOutcome | null = null;
  /**
   * Counted from attempts that were actually AUTHORIZED AND STARTED, never from intent. An earlier
   * revision incremented on "we would like to retry", so a retry the ledger then refused still
   * reported retryCount: 1 -- the same class of after-the-fact misreporting that let the first
   * billed preflight's overrun go unnoticed.
   */
  let startedAttempts = 0;
  let modelProvenance = classifyModelProvenance({
    requestedModel: config.requestedModel,
    reportedModel: null,
  });

  for (;;) {
    const authorization = ledger.beginAttempt();
    if (!authorization.allowed) {
      // Record the refusal as evidence. A refused attempt never spawned a process and cost nothing,
      // but hiding it would make a blocked retry indistinguishable from one that never came up.
      attempts.push({
        attempt: authorization.attemptNumber,
        purpose: "PARTICIPANT",
        started: false,
        ...(authorization.reason ? { refusalReason: authorization.reason } : {}),
        ...(authorization.detail ? { refusalDetail: authorization.detail } : {}),
        requestedModel: config.requestedModel,
        reportedModel: null,
        modelResolutionStatus: "NOT_REPORTED",
        effort: config.effort,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        attemptTimeoutMs: 0,
        attemptBudgetUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        costUsd: null,
        costStatus: "UNKNOWN",
        resultSubtype: null,
        resultIsError: null,
        exitCode: null,
        terminationSignal: null,
        classification: "INFRASTRUCTURE_FAILURE",
        firstFailure: authorization.detail ?? "the run ledger refused this attempt",
        exitCodeDiscrepancy: false,
        stderr: { observed: false, totalChars: 0, truncated: false, summary: null, tail: null },
        spawn: null,
      });
      break;
    }

    startedAttempts += 1;
    // Each attempt is capped by what REMAINS of the run budget, not by the full per-run ceiling.
    config.applyAttemptBudget?.(authorization.attemptBudgetUsd);

    const session = await runAgentSession({
      adapter: params.adapter,
      input: params.input,
      prompt: params.prompt,
      timeoutMs: authorization.attemptTimeoutMs,
      ...(params.onEvent ? { onEvent: params.onEvent } : {}),
    });
    ledger.recordAttemptSpend({
      costUsd: session.reportedCost,
      inputTokens: session.usage.inputTokens,
      outputTokens: session.usage.outputTokens,
      cachedTokens: session.usage.cachedTokens,
    });

    const attemptProvenance = classifyModelProvenance({
      requestedModel: config.requestedModel,
      reportedModel: session.reportedModel,
    });
    // Keep the most informative model identity observed across attempts: a later attempt that
    // reported nothing must not erase an earlier attempt's real identifier.
    if (
      modelProvenance.resolvedModelStatus === "NOT_REPORTED" ||
      attemptProvenance.resolvedModelStatus === "RESOLVED"
    ) {
      modelProvenance = attemptProvenance;
    }

    attempts.push({
      attempt: authorization.attemptNumber,
      purpose: "PARTICIPANT",
      started: true,
      requestedModel: config.requestedModel,
      reportedModel: attemptProvenance.rawReportedModel,
      modelResolutionStatus: attemptProvenance.resolvedModelStatus,
      effort: config.effort,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      durationMs: session.durationMs,
      attemptTimeoutMs: authorization.attemptTimeoutMs,
      attemptBudgetUsd: authorization.attemptBudgetUsd,
      usage: { ...session.usage },
      costUsd: session.reportedCost,
      costStatus: costStatusForAttempt(session.reportedCost),
      resultSubtype: session.resultSubtype,
      resultIsError: session.resultIsError,
      exitCode: session.exitCode,
      terminationSignal: session.terminationSignal,
      classification: session.outcome.classification,
      firstFailure: session.outcome.firstFailure,
      exitCodeDiscrepancy: session.outcome.exitCodeDiscrepancy,
      stderr: session.stderr,
      spawn: session.spawn,
    });

    finalSession = session;
    finalOutcome = session.outcome;

    const retriesSoFar = startedAttempts - 1;
    const wantsRetry =
      isAutoRetryableAttempt(session.outcome.classification) &&
      retriesSoFar < config.maxRecoveryAttempts;
    if (!wantsRetry) break;
  }

  return {
    finalSession,
    finalOutcome: finalOutcome ?? {
      classification: "INFRASTRUCTURE_FAILURE",
      executionStatus: "INFRA_FAILURE",
      autoRetryable: false,
      firstFailure:
        attempts[0]?.firstFailure ?? "no provider invocation was authorized for this run",
      evidence: ["the run ledger refused every attempt before any process was created"],
      exitCodeDiscrepancy: false,
    },
    attempts,
    modelProvenance,
    retries: Math.max(0, startedAttempts - 1),
    totals: ledger.totals(),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
};
