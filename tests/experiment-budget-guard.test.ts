import { describe, expect, it } from "vitest";
import { BudgetGuard } from "../evaluation/experiments/real/lib/budget-guard";

describe("BudgetGuard", () => {
  it("passes the frozen per-run ceiling through for the CLI's --max-budget-usd flag", () => {
    const guard = new BudgetGuard({ limitUsd: 8, cliEnforcementAvailable: true });
    expect(guard.maxBudgetUsdForAdapter()).toBe(8);
    expect(guard.allocation.total).toBe(8);
  });

  it("reports UNKNOWN post-hoc status when no cost was ever observed, never a fabricated pass/fail", () => {
    const guard = new BudgetGuard({ limitUsd: 8, cliEnforcementAvailable: true });
    const record = guard.finalize(null);
    expect(record.postHocStatus).toBe("UNKNOWN");
    expect(record.controllerEnforcesRealTimeCutoff).toBe(false);
    expect(record.enforcementMechanism).toBe("CLI_INTERNAL_MAX_BUDGET_FLAG");
  });

  it("reports WITHIN_BUDGET when the final reported cost is at or under the ceiling", () => {
    const guard = new BudgetGuard({ limitUsd: 8, cliEnforcementAvailable: true });
    expect(guard.finalize(7.99).postHocStatus).toBe("WITHIN_BUDGET");
    expect(guard.finalize(8).postHocStatus).toBe("WITHIN_BUDGET");
  });

  it("reports OVER_BUDGET when the final reported cost exceeds the ceiling", () => {
    const guard = new BudgetGuard({ limitUsd: 8, cliEnforcementAvailable: true });
    expect(guard.finalize(8.01).postHocStatus).toBe("OVER_BUDGET");
  });

  it("discloses POST_HOC_DETECTION_ONLY honestly when no CLI enforcement flag is available", () => {
    const guard = new BudgetGuard({ limitUsd: 8, cliEnforcementAvailable: false });
    const record = guard.finalize(3);
    expect(record.enforcementMechanism).toBe("POST_HOC_DETECTION_ONLY");
    expect(record.limitation).toMatch(/no incremental budget signal/i);
  });

  it("rejects a non-positive limit rather than silently accepting an unenforceable budget", () => {
    expect(() => new BudgetGuard({ limitUsd: 0, cliEnforcementAvailable: true })).toThrow();
    expect(() => new BudgetGuard({ limitUsd: -1, cliEnforcementAvailable: true })).toThrow();
  });
});
