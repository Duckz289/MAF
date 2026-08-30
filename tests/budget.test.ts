import { describe, expect, it } from "vitest";
import {
  authorizeSpend,
  type BudgetCategory,
  computeAllocation,
  defaultBudgetReservationPolicy,
  estimateFromHistory,
  maxPlausibleSingleEventCostUsd,
  sanitizeReportedCost,
} from "../src/domain/budget";

describe("sanitizeReportedCost", () => {
  it("accepts a plausible non-negative finite value", () => {
    expect(sanitizeReportedCost(0.05)).toBe(0.05);
    expect(sanitizeReportedCost(0)).toBe(0);
  });

  it("rejects a negative value rather than letting spend go backwards", () => {
    expect(sanitizeReportedCost(-1)).toBeNull();
  });

  it("rejects non-finite values", () => {
    expect(sanitizeReportedCost(Number.NaN)).toBeNull();
    expect(sanitizeReportedCost(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rejects an implausibly large single-event value", () => {
    expect(sanitizeReportedCost(maxPlausibleSingleEventCostUsd + 1)).toBeNull();
    expect(sanitizeReportedCost(maxPlausibleSingleEventCostUsd)).toBe(
      maxPlausibleSingleEventCostUsd,
    );
  });

  it("rejects non-numeric values", () => {
    expect(sanitizeReportedCost("0.05")).toBeNull();
    expect(sanitizeReportedCost(undefined)).toBeNull();
    expect(sanitizeReportedCost(null)).toBeNull();
  });
});

describe("computeAllocation", () => {
  it("returns null when no limit is configured — unknown, not zero", () => {
    expect(computeAllocation({ mode: "ADVISORY", limitUsd: null })).toBeNull();
    expect(computeAllocation({ mode: "HARD", limitUsd: null })).toBeNull();
  });

  it("splits a limit across categories so verification is never starved by execution", () => {
    const allocation = computeAllocation({ mode: "HARD", limitUsd: 10 });
    expect(allocation).toMatchObject({ total: 10 });
    expect(allocation?.execution).toBeCloseTo(6);
    expect(allocation?.verification).toBeCloseTo(2.5);
    expect(allocation?.recovery).toBeCloseTo(1.5);
    expect(
      (allocation?.execution ?? 0) + (allocation?.verification ?? 0) + (allocation?.recovery ?? 0),
    ).toBeCloseTo(10);
  });

  it("honors a custom reservation policy", () => {
    const allocation = computeAllocation(
      { mode: "HARD", limitUsd: 100 },
      { executionShare: 0.5, verificationShare: 0.5, recoveryShare: 0 },
    );
    expect(allocation).toMatchObject({ execution: 50, verification: 50, recovery: 0 });
  });
});

describe("authorizeSpend", () => {
  const spent = (
    execution: number,
    verification = 0,
    recovery = 0,
  ): Record<BudgetCategory, number> => ({
    execution,
    verification,
    recovery,
  });

  it("always authorizes when no budget is configured", () => {
    const authorization = authorizeSpend(null, spent(1_000_000), "execution", "HARD");
    expect(authorization).toMatchObject({ authorized: true, allocated: null, remaining: null });
  });

  it("blocks HARD spend once a category's reserve is exhausted", () => {
    const allocation = computeAllocation(
      { mode: "HARD", limitUsd: 10 },
      defaultBudgetReservationPolicy,
    );
    const authorized = authorizeSpend(allocation, spent(5), "execution", "HARD");
    expect(authorized.authorized).toBe(true);
    expect(authorized.remaining).toBeCloseTo(1);
    const denied = authorizeSpend(allocation, spent(6), "execution", "HARD");
    expect(denied.authorized).toBe(false);
    expect(denied.remaining).toBeLessThanOrEqual(0);
  });

  it("never blocks ADVISORY spend but honestly reports an overrun", () => {
    const allocation = computeAllocation({ mode: "ADVISORY", limitUsd: 10 });
    const authorized = authorizeSpend(allocation, spent(50), "execution", "ADVISORY");
    expect(authorized.authorized).toBe(true);
    expect(authorized.advisoryOverrun).toBe(true);
  });

  it("keeps each category's reserve independent — exhausting execution never blocks verification", () => {
    const allocation = computeAllocation(
      { mode: "HARD", limitUsd: 10 },
      defaultBudgetReservationPolicy,
    );
    const executionDenied = authorizeSpend(allocation, spent(100, 0, 0), "execution", "HARD");
    expect(executionDenied.authorized).toBe(false);
    const verificationStillAuthorized = authorizeSpend(
      allocation,
      spent(100, 0, 0),
      "verification",
      "HARD",
    );
    expect(verificationStillAuthorized.authorized).toBe(true);
  });
});

describe("estimateFromHistory", () => {
  it("returns null (genuinely unknown) when there is no prior cost data", () => {
    expect(estimateFromHistory(null)).toBeNull();
    expect(estimateFromHistory(0)).toBeNull();
  });

  it("returns a bounded range anchored to history, never a fabricated point figure", () => {
    const estimate = estimateFromHistory(1.0);
    expect(estimate).not.toBeNull();
    expect(estimate?.low).toBeLessThan(estimate?.high ?? 0);
    expect(estimate?.confidence).toBe("MEDIUM");
    expect(estimate?.basis).toContain("historical");
  });
});
