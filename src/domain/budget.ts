/**
 * Budget authority: deterministic, bounded budget accounting and authorization. Never calls a
 * model to decide whether spend is allowed, and never presents a fabricated point cost estimate —
 * an unconfigured or unknown quantity stays null, not $0 and not a guess.
 */

/** Thrown when a spend-triggering action is refused because a HARD budget category is exhausted. */
export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/** A single usage event's self-reported cost above this is rejected as implausible, not applied. */
export const maxPlausibleSingleEventCostUsd = 1_000;

/**
 * Agent output is a proposal, never silently trusted — including its own claimed cost. Rejects a
 * negative, non-finite, or implausibly large single-event value rather than applying it. Returns
 * null (rejected, unknown) rather than clamping to some other number, which would itself be a
 * fabricated figure. This cannot fully prevent an agent that consistently under-reports (e.g.
 * always claims $0) from bypassing a HARD budget — that requires independent metering, out of
 * scope here — but it closes the two concrete abuse shapes a single bad value can cause: driving
 * spend negative, or forcing an immediate self-inflicted pause by claiming an absurd cost.
 */
export const sanitizeReportedCost = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > maxPlausibleSingleEventCostUsd) return null;
  return value;
};

export type BudgetMode = "ADVISORY" | "HARD";
export type BudgetCategory = "execution" | "verification" | "recovery";

export interface BudgetPolicy {
  mode: BudgetMode;
  /** null means no limit was configured for this scope — tracked, but never blocks spend. */
  limitUsd: number | null;
}

/** Fractions of the total budget reserved per category. Must sum to 1. */
export interface BudgetReservationPolicy {
  executionShare: number;
  verificationShare: number;
  recoveryShare: number;
}

export const defaultBudgetReservationPolicy: BudgetReservationPolicy = {
  executionShare: 0.6,
  verificationShare: 0.25,
  recoveryShare: 0.15,
};

export interface BudgetAllocation {
  execution: number;
  verification: number;
  recovery: number;
  total: number;
}

/**
 * Splits a limit across categories so execution spend can never silently consume the money
 * mandatory verification (or bounded recovery) needs. Returns null when no limit is configured —
 * an unconfigured budget has no allocation to report, not a zero one.
 */
export const computeAllocation = (
  policy: BudgetPolicy,
  reservation: BudgetReservationPolicy = defaultBudgetReservationPolicy,
): BudgetAllocation | null => {
  if (policy.limitUsd === null) return null;
  const total = policy.limitUsd;
  return {
    execution: total * reservation.executionShare,
    verification: total * reservation.verificationShare,
    recovery: total * reservation.recoveryShare,
    total,
  };
};

export interface BudgetAuthorization {
  category: BudgetCategory;
  mode: BudgetMode;
  authorized: boolean;
  /** null when no limit is configured for this category (nothing to compare spend against). */
  allocated: number | null;
  spent: number;
  /** null mirrors `allocated`: unknown, not zero. */
  remaining: number | null;
  /** True only for ADVISORY mode when spend has exceeded its allocation without being blocked. */
  advisoryOverrun: boolean;
}

/**
 * Whether a spend-triggering action (starting/continuing an agent session, a bounded repair, a
 * bounded recovery retry) is authorized for a category. HARD mode blocks once the category's
 * reserve is exhausted; ADVISORY mode never blocks but honestly reports an overrun. No budget
 * configured (allocation null) always authorizes — there is nothing to enforce against.
 */
export const authorizeSpend = (
  allocation: BudgetAllocation | null,
  spentByCategory: Record<BudgetCategory, number>,
  category: BudgetCategory,
  mode: BudgetMode,
): BudgetAuthorization => {
  const spent = spentByCategory[category];
  if (allocation === null) {
    return {
      category,
      mode,
      authorized: true,
      allocated: null,
      spent,
      remaining: null,
      advisoryOverrun: false,
    };
  }
  const allocated = allocation[category];
  const remaining = allocated - spent;
  const overrun = remaining <= 0;
  return {
    category,
    mode,
    authorized: mode === "ADVISORY" || !overrun,
    allocated,
    spent,
    remaining,
    advisoryOverrun: mode === "ADVISORY" && overrun,
  };
};

export type CostConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface CostEstimate {
  low: number;
  high: number;
  confidence: CostConfidence;
  basis: string;
}

/**
 * A bounded range, never a fabricated point figure. Returns null (genuinely UNKNOWN) when there
 * is no historical cost-per-verified-success to anchor the range to — no guess is better than a
 * confident-looking wrong one.
 */
export const estimateFromHistory = (
  priorCostPerVerifiedSuccess: number | null,
): CostEstimate | null => {
  if (priorCostPerVerifiedSuccess === null || priorCostPerVerifiedSuccess <= 0) return null;
  return {
    low: Math.round(priorCostPerVerifiedSuccess * 0.6 * 100) / 100,
    high: Math.round(priorCostPerVerifiedSuccess * 1.6 * 100) / 100,
    confidence: "MEDIUM",
    basis: "historical cost-per-verified-success across prior completed runs",
  };
};
