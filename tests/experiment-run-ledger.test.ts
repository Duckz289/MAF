import { describe, expect, it } from "vitest";
import { RunExecutionLedger } from "../evaluation/experiments/real/lib/run-ledger";

const ledgerWithClock = (
  overrides: Partial<ConstructorParameters<typeof RunExecutionLedger>[0]> = {},
) => {
  let now = 0;
  const ledger = new RunExecutionLedger({
    runBudgetUsd: 8,
    runTimeoutMs: 1_800_000,
    maxProviderInvocations: 2,
    now: () => now,
    ...overrides,
  });
  return { ledger, advance: (ms: number) => (now += ms) };
};

describe("provider invocation ceiling (authorization overrun)", () => {
  it("refuses a second invocation when only one is allowed, BEFORE any spawn", () => {
    const { ledger } = ledgerWithClock({ maxProviderInvocations: 1 });
    expect(ledger.beginAttempt().allowed).toBe(true);
    ledger.recordAttemptSpend({ costUsd: 0.5, inputTokens: 1, outputTokens: 1, cachedTokens: 0 });

    const second = ledger.beginAttempt();
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("INVOCATION_CEILING_REACHED");
    expect(ledger.providerInvocationsStarted).toBe(1);
    expect(ledger.providerInvocationsRefused).toBe(1);
  });

  it("counts started invocations, so a refusal never inflates the spawn count", () => {
    const { ledger } = ledgerWithClock({ maxProviderInvocations: 0 });
    expect(ledger.beginAttempt().allowed).toBe(false);
    expect(ledger.providerInvocationsStarted).toBe(0);
  });
});

describe("run-level budget across retries ($8 PER RUN, not per attempt)", () => {
  it("gives a retry only the REMAINING run budget", () => {
    const { ledger } = ledgerWithClock();
    const first = ledger.beginAttempt();
    expect(first.attemptBudgetUsd).toBe(8);
    ledger.recordAttemptSpend({ costUsd: 3, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

    const second = ledger.beginAttempt();
    expect(second.allowed).toBe(true);
    // $3 spent -> at most $5 may remain available to the retry. Never a fresh $8.
    expect(second.attemptBudgetUsd).toBe(5);
  });

  it("refuses a retry once the remaining budget falls below the practical minimum", () => {
    const { ledger } = ledgerWithClock();
    ledger.beginAttempt();
    ledger.recordAttemptSpend({ costUsd: 7.99, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

    const second = ledger.beginAttempt();
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("RUN_BUDGET_EXHAUSTED");
  });

  it("allows a retry with a reduced ceiling when meaningful budget remains", () => {
    const { ledger } = ledgerWithClock();
    ledger.beginAttempt();
    ledger.recordAttemptSpend({ costUsd: 7.5, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

    const second = ledger.beginAttempt();
    expect(second.allowed).toBe(true);
    expect(second.attemptBudgetUsd).toBeCloseTo(0.5, 10);
  });

  it("fails closed: an unmeasured first attempt blocks any further BILLED attempt", () => {
    const { ledger } = ledgerWithClock();
    ledger.beginAttempt();
    ledger.recordAttemptSpend({ costUsd: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

    expect(ledger.remainingRunBudgetUsd()).toBeNull();
    const second = ledger.beginAttempt();
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("REMAINING_BUDGET_UNKNOWN");
  });
});

describe("run-level timeout across retries (30 min PER RUN, not per attempt)", () => {
  it("gives a retry only the REMAINING run time", () => {
    const { ledger, advance } = ledgerWithClock();
    const first = ledger.beginAttempt();
    expect(first.attemptTimeoutMs).toBe(1_800_000);
    ledger.recordAttemptSpend({ costUsd: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

    advance(20 * 60_000); // 20 minutes consumed
    const second = ledger.beginAttempt();
    expect(second.allowed).toBe(true);
    // A retry must NOT reset the full 30-minute timer.
    expect(second.attemptTimeoutMs).toBe(10 * 60_000);
  });

  it("refuses a retry when no meaningful run time remains", () => {
    const { ledger, advance } = ledgerWithClock();
    ledger.beginAttempt();
    ledger.recordAttemptSpend({ costUsd: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

    advance(1_800_000);
    const second = ledger.beginAttempt();
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("RUN_DEADLINE_EXHAUSTED");
  });

  it("keeps the run deadline fixed from ledger construction", () => {
    const { ledger, advance } = ledgerWithClock();
    const deadline = ledger.runDeadlineMs;
    advance(60_000);
    expect(ledger.runDeadlineMs).toBe(deadline);
    expect(ledger.remainingRunTimeMs()).toBe(1_800_000 - 60_000);
  });
});

describe("multi-attempt cost aggregation", () => {
  it("sums a failed attempt and a successful retry rather than keeping only the last", () => {
    const { ledger } = ledgerWithClock();
    ledger.beginAttempt();
    ledger.recordAttemptSpend({ costUsd: 2, inputTokens: 10, outputTokens: 5, cachedTokens: 1 });
    ledger.beginAttempt();
    ledger.recordAttemptSpend({ costUsd: 1, inputTokens: 20, outputTokens: 7, cachedTokens: 2 });

    const totals = ledger.totals();
    expect(totals.knownCostUsd).toBe(3);
    expect(totals.costStatus).toBe("KNOWN");
    expect(totals.inputTokens).toBe(30);
    expect(totals.outputTokens).toBe(12);
    expect(totals.cachedTokens).toBe(3);
  });

  it("reports PARTIAL when some attempts never reported a cost, never treating them as $0", () => {
    const { ledger } = ledgerWithClock();
    ledger.beginAttempt();
    ledger.recordAttemptSpend({ costUsd: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    ledger.recordAttemptSpend({ costUsd: 2, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

    const totals = ledger.totals();
    expect(totals.costStatus).toBe("PARTIAL");
    expect(totals.knownCostUsd).toBe(2);
    expect(totals.attemptsWithUnknownCost).toBe(1);
  });

  it("reports UNKNOWN when no attempt ever reported a cost", () => {
    const { ledger } = ledgerWithClock();
    ledger.beginAttempt();
    ledger.recordAttemptSpend({ costUsd: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(ledger.totals().costStatus).toBe("UNKNOWN");
  });
});

describe("ledger construction guards", () => {
  it("rejects non-positive budgets and timeouts rather than accepting an unenforceable ceiling", () => {
    expect(
      () => new RunExecutionLedger({ runBudgetUsd: 0, runTimeoutMs: 1, maxProviderInvocations: 1 }),
    ).toThrow();
    expect(
      () => new RunExecutionLedger({ runBudgetUsd: 1, runTimeoutMs: 0, maxProviderInvocations: 1 }),
    ).toThrow();
    expect(
      () =>
        new RunExecutionLedger({ runBudgetUsd: 1, runTimeoutMs: 1, maxProviderInvocations: -1 }),
    ).toThrow();
  });
});
