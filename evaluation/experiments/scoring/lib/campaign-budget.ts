// Campaign-level spend accounting and the pre-spawn cost gate.
//
// This is an OPERATIONAL safety limit and nothing more. It answers exactly one question -- "could
// authorizing one more run at the frozen per-run ceiling exceed the operator's authorized total?" --
// and it answers it from spend alone. It never reads a DVS, an outcome, or a trend, because a
// campaign that stops when results look a certain way is no longer the pre-registered fixed-N
// experiment (EXPERIMENT_PROTOCOL.md section 18). Stopping on money is pre-registered; stopping on
// results is not.
//
// The fail-closed rule that matters: if ANY completed attempt never reported its cost, the true
// spend-so-far is unknown, so the true remaining headroom is also unknown. The gate then refuses to
// authorize a new paid slot rather than treating unmeasured spend as $0 -- the same "UNKNOWN never
// becomes zero" discipline the per-run ledger already applies.

import type { ObservationRecord, SlotState } from "./state-store";

export interface CampaignSpend {
  /** Sum of costs actually reported. A LOWER BOUND when `unknownCostObservations > 0`. */
  knownSpendUsd: number;
  observationsWithKnownCost: number;
  observationsWithPartialCost: number;
  /** Observations that never reported any cost. Their real spend is genuinely unknown. */
  unknownCostObservations: number;
  totalObservations: number;
  /** KNOWN when every observation reported cost; PARTIAL/UNKNOWN otherwise. */
  spendStatus: "KNOWN" | "PARTIAL" | "UNKNOWN";
  /** True when spend-so-far cannot be established, making remaining headroom unknowable. */
  headroomUnknowable: boolean;
}

export const summarizeCampaignSpend = (states: readonly SlotState[]): CampaignSpend => {
  const observations: ObservationRecord[] = states.flatMap((state) => state.observations);
  let knownSpendUsd = 0;
  let known = 0;
  let partial = 0;
  let unknown = 0;

  for (const observation of observations) {
    if (observation.costStatus === "KNOWN" && typeof observation.costUsd === "number") {
      knownSpendUsd += observation.costUsd;
      known += 1;
    } else if (observation.costStatus === "PARTIAL" && typeof observation.costUsd === "number") {
      // A partial figure is real money that was measured; it counts toward the lower bound, but it
      // does not make the total knowable.
      knownSpendUsd += observation.costUsd;
      partial += 1;
    } else {
      unknown += 1;
    }
  }

  const total = observations.length;
  const spendStatus: CampaignSpend["spendStatus"] =
    total === 0 || unknown === total
      ? total === 0
        ? "KNOWN"
        : "UNKNOWN"
      : unknown + partial > 0
        ? "PARTIAL"
        : "KNOWN";

  return {
    knownSpendUsd,
    observationsWithKnownCost: known,
    observationsWithPartialCost: partial,
    unknownCostObservations: unknown,
    totalObservations: total,
    spendStatus,
    headroomUnknowable: unknown > 0 || partial > 0,
  };
};

export type CampaignGateStatus =
  | "AUTHORIZED"
  | "NO_CEILING_CONFIGURED"
  | "CEILING_WOULD_BE_EXCEEDED"
  | "REMAINING_SPEND_UNKNOWABLE";

export interface CampaignGateDecision {
  status: CampaignGateStatus;
  authorized: boolean;
  spend: CampaignSpend;
  ceilingUsd: number | null;
  perRunCeilingUsd: number;
  /** Ceiling minus known spend. Null when spend is not knowable. */
  remainingUsd: number | null;
  detail: string;
}

/**
 * Decides whether ONE more slot may be authorized, BEFORE anything is spawned.
 *
 * Deliberately pessimistic: it compares against the frozen per-run ceiling ($8), not against an
 * average or an estimate, because a run is permitted to spend the whole ceiling and a gate that
 * assumed less could authorize a run that then breached the operator's total.
 */
export const evaluateCampaignGate = (input: {
  states: readonly SlotState[];
  ceilingUsd: number | null;
  perRunCeilingUsd: number;
}): CampaignGateDecision => {
  const spend = summarizeCampaignSpend(input.states);
  const base = {
    spend,
    ceilingUsd: input.ceilingUsd,
    perRunCeilingUsd: input.perRunCeilingUsd,
  };

  if (input.ceilingUsd === null || input.ceilingUsd === undefined) {
    return {
      ...base,
      status: "NO_CEILING_CONFIGURED",
      authorized: false,
      remainingUsd: null,
      detail:
        "no operator-authorized campaign ceiling was supplied; billed scoring requires an explicit " +
        "total spend authorization and no default is baked in",
    };
  }
  if (!(input.ceilingUsd > 0) || !Number.isFinite(input.ceilingUsd)) {
    return {
      ...base,
      status: "NO_CEILING_CONFIGURED",
      authorized: false,
      remainingUsd: null,
      detail: `campaign ceiling must be a positive finite number, received ${input.ceilingUsd}`,
    };
  }
  if (spend.headroomUnknowable) {
    return {
      ...base,
      status: "REMAINING_SPEND_UNKNOWABLE",
      authorized: false,
      remainingUsd: null,
      detail:
        `${spend.unknownCostObservations} observation(s) reported no cost and ` +
        `${spend.observationsWithPartialCost} reported only a partial cost, so spend so far is a ` +
        `lower bound of $${spend.knownSpendUsd.toFixed(4)} rather than a known total. The remaining ` +
        "campaign headroom cannot be established, so a further paid slot is refused (fail closed).",
    };
  }

  const remainingUsd = input.ceilingUsd - spend.knownSpendUsd;
  if (remainingUsd < input.perRunCeilingUsd) {
    return {
      ...base,
      status: "CEILING_WOULD_BE_EXCEEDED",
      authorized: false,
      remainingUsd,
      detail:
        `only $${remainingUsd.toFixed(4)} remains of the $${input.ceilingUsd} operator-authorized ` +
        `campaign ceiling, which is less than the frozen $${input.perRunCeilingUsd} a single run is ` +
        "permitted to spend; stopping BEFORE spawn rather than risking a breach mid-run",
    };
  }

  return {
    ...base,
    status: "AUTHORIZED",
    authorized: true,
    remainingUsd,
    detail:
      `$${remainingUsd.toFixed(4)} of the $${input.ceilingUsd} campaign ceiling remains, which ` +
      `covers the frozen $${input.perRunCeilingUsd} per-run ceiling`,
  };
};

/** Absolute worst case for the full frozen campaign: 174 runs x $8. Reported, never enforced as N. */
export const theoreticalMaximumCampaignUsd = (
  totalRuns: number,
  perRunCeilingUsd: number,
): number => totalRuns * perRunCeilingUsd;
