// Honest budget wiring for the $8.00/run HARD ceiling (EXPERIMENT_PROTOCOL.md section 9,
// evaluation/experiments/native-vs-maf-v2.json budget.perRunCeilingUsd).
//
// src/domain/budget.ts computeAllocation/authorizeSpend are cumulative-spend accounting: they compare
// spend-so-far against an allocation and authorize or refuse the NEXT spend-triggering action. They
// were designed for a run that reports incremental spend as it goes (RunService's execution/
// verification/recovery categories). A single non-interactive Claude Code CLI invocation
// (`claude -p`) reports nothing until it exits, so there is no incremental spend signal for
// authorizeSpend to gate mid-run -- calling it here would only ever authorize the one spend it can
// see (start-of-run, $0 spent so far) and would never be able to refuse anything before the process
// has already finished and already spent whatever it spent.
//
// The actually-enforceable mechanism is the Claude Code CLI's own `--max-budget-usd` flag, already
// wired into src/infrastructure/claude-code-adapter.ts (ClaudeCodeConfig.maxBudgetUsd) before this
// mission. Passing the frozen per-run ceiling there delegates real-time enforcement to the CLI
// process itself; the controller cannot independently verify the CLI's internal accounting
// granularity, so this module also runs computeAllocation for the record (reservation shares of the
// $8 ceiling across execution/verification/recovery, matching RunService's own budget semantics) and
// compares the FINAL reported cost against the ceiling after the run completes, purely as a
// post-hoc, non-blocking cross-check.
//
// What this module does NOT claim: it does not stop an in-flight process at some intermediate dollar
// figure by its own action. That claim would be false for the current adapter and is not made here.

import {
  computeAllocation,
  defaultBudgetReservationPolicy,
  type BudgetAllocation,
} from "../../../../src/domain/budget";
import type { BudgetEnforcementRecord } from "./provenance";

export interface BudgetGuardConfig {
  limitUsd: number;
  /** True when the underlying adapter actually accepts and forwards a max-budget flag to the CLI. */
  cliEnforcementAvailable: boolean;
}

export class BudgetGuard {
  readonly allocation: BudgetAllocation;

  constructor(private readonly config: BudgetGuardConfig) {
    if (!(config.limitUsd > 0)) throw new Error("Budget guard requires a positive limitUsd");
    const allocation = computeAllocation(
      { mode: "HARD", limitUsd: config.limitUsd },
      defaultBudgetReservationPolicy,
    );
    // limitUsd > 0 above guarantees computeAllocation never returns null.
    if (!allocation)
      throw new Error("Unreachable: budget allocation was null for a positive limit");
    this.allocation = allocation;
  }

  /** The value to pass as ClaudeCodeConfig.maxBudgetUsd, honoring the frozen per-run ceiling. */
  maxBudgetUsdForAdapter(): number {
    return this.config.limitUsd;
  }

  /** Post-hoc, non-blocking comparison of what a run actually reported against the ceiling. */
  finalize(reportedCostUsd: number | null): BudgetEnforcementRecord {
    const mechanism: BudgetEnforcementRecord["enforcementMechanism"] = this.config
      .cliEnforcementAvailable
      ? "CLI_INTERNAL_MAX_BUDGET_FLAG"
      : "POST_HOC_DETECTION_ONLY";
    const postHocStatus: BudgetEnforcementRecord["postHocStatus"] =
      reportedCostUsd === null
        ? "UNKNOWN"
        : reportedCostUsd > this.config.limitUsd
          ? "OVER_BUDGET"
          : "WITHIN_BUDGET";
    return {
      mode: "HARD",
      limitUsd: this.config.limitUsd,
      enforcementMechanism: mechanism,
      controllerEnforcesRealTimeCutoff: false,
      postHocStatus,
      limitation:
        mechanism === "CLI_INTERNAL_MAX_BUDGET_FLAG"
          ? "The controller passes --max-budget-usd to the Claude Code CLI and relies on the CLI's " +
            "own internal cost accounting to stop the session early; the controller does not " +
            "independently meter spend during the run and cannot verify the CLI's internal " +
            "enforcement granularity. The value above is the controller's own after-the-fact " +
            "comparison of the CLI's final reported cost against the ceiling, not a second " +
            "enforcement mechanism."
          : "No incremental budget signal was available from this participant at all (e.g. a test " +
            "adapter that does not support a budget flag). The value above is a purely post-hoc " +
            "comparison of the final reported cost against the ceiling; nothing stopped the run " +
            "before it finished.",
    };
  }
}
