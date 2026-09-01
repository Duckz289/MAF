// Run-level accounting across ALL attempts of one experiment run.
//
// The frozen protocol says $8.00 and 1,800,000ms PER RUN, not per attempt. Before this repair, each
// adapter invocation received the full `--max-budget-usd 8` and the full 30-minute timeout, so a
// single MAF run that retried once could spend up to $16 and run for up to 60 minutes while every
// report still claimed the frozen per-run ceilings had been honored. This ledger makes the run --
// not the attempt -- the unit those ceilings apply to.
//
// It also owns the hard provider-invocation ceiling. The first billed preflight authorized two
// participant executions and performed three, because nothing counted spawns BEFORE they happened;
// `retryCount` was only reported afterwards, which is far too late to prevent spending money.
// `beginAttempt()` must be called and must succeed before any process is created.

export type AttemptRefusalReason =
  | "INVOCATION_CEILING_REACHED"
  | "RUN_DEADLINE_EXHAUSTED"
  | "RUN_BUDGET_EXHAUSTED"
  | "REMAINING_BUDGET_UNKNOWN";

export interface AttemptAuthorization {
  allowed: boolean;
  /** Dollar ceiling for THIS attempt: never more than what remains of the run budget. */
  attemptBudgetUsd: number;
  /** Timeout for THIS attempt: never more than what remains of the run deadline. */
  attemptTimeoutMs: number;
  attemptNumber: number;
  reason?: AttemptRefusalReason;
  detail?: string;
}

export interface AttemptSpend {
  /** Null means the attempt's cost was never observed. Never coerced to 0. */
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface RunCostTotals {
  /** Sum of every attempt's known cost. Attempts with unknown cost contribute nothing here and are
   *  counted in `attemptsWithUnknownCost` instead -- never silently treated as $0. */
  knownCostUsd: number;
  attemptsWithKnownCost: number;
  attemptsWithUnknownCost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** KNOWN: every attempt's cost was observed. PARTIAL: some were. UNKNOWN: none were. */
  costStatus: "KNOWN" | "PARTIAL" | "UNKNOWN";
}

export interface RunLedgerConfig {
  runBudgetUsd: number;
  runTimeoutMs: number;
  /** Hard ceiling on provider invocations for this run. Preflight passes 1; scoring passes more. */
  maxProviderInvocations: number;
  /** Below this remaining budget a further billed attempt is pointless and is refused. */
  minimumAttemptBudgetUsd?: number;
  /** Below this remaining time a further attempt cannot do useful work and is refused. */
  minimumAttemptTimeMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const DEFAULT_MINIMUM_ATTEMPT_BUDGET_USD = 0.05;
const DEFAULT_MINIMUM_ATTEMPT_TIME_MS = 5_000;

export class RunExecutionLedger {
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly minimumAttemptBudgetUsd: number;
  private readonly minimumAttemptTimeMs: number;
  private readonly spends: AttemptSpend[] = [];
  private invocationsStarted = 0;
  private invocationsRefused = 0;

  constructor(private readonly config: RunLedgerConfig) {
    if (!(config.runBudgetUsd > 0)) throw new Error("Run ledger requires a positive runBudgetUsd");
    if (!(config.runTimeoutMs > 0)) throw new Error("Run ledger requires a positive runTimeoutMs");
    if (!Number.isInteger(config.maxProviderInvocations) || config.maxProviderInvocations < 0) {
      throw new Error("Run ledger requires a non-negative integer maxProviderInvocations");
    }
    this.now = config.now ?? (() => Date.now());
    this.startedAtMs = this.now();
    this.minimumAttemptBudgetUsd =
      config.minimumAttemptBudgetUsd ?? DEFAULT_MINIMUM_ATTEMPT_BUDGET_USD;
    this.minimumAttemptTimeMs = config.minimumAttemptTimeMs ?? DEFAULT_MINIMUM_ATTEMPT_TIME_MS;
  }

  /** Absolute wall-clock deadline for the whole run, fixed when the ledger was created. */
  get runDeadlineMs(): number {
    return this.startedAtMs + this.config.runTimeoutMs;
  }

  get providerInvocationsStarted(): number {
    return this.invocationsStarted;
  }

  get providerInvocationsRefused(): number {
    return this.invocationsRefused;
  }

  get maxProviderInvocations(): number {
    return this.config.maxProviderInvocations;
  }

  remainingRunTimeMs(): number {
    return Math.max(0, this.runDeadlineMs - this.now());
  }

  /**
   * Remaining run budget, or null when it cannot be known.
   *
   * Null is returned as soon as ANY completed attempt failed to report its cost: with an unmeasured
   * attempt in the history, the controller genuinely does not know how much of the $8 is left, and
   * pretending the full remainder is available is exactly the fabrication this codebase refuses to
   * make elsewhere (UNKNOWN never becomes 0, and it never becomes "plenty" either).
   */
  remainingRunBudgetUsd(): number | null {
    if (this.spends.some((spend) => spend.costUsd === null)) return null;
    const spent = this.spends.reduce((total, spend) => total + (spend.costUsd ?? 0), 0);
    return Math.max(0, this.config.runBudgetUsd - spent);
  }

  /**
   * Authorizes one provider invocation. MUST be called, and MUST return allowed=true, BEFORE any
   * process is spawned. A refusal is recorded so the report can show attempts that were blocked
   * rather than silently omitting them.
   */
  beginAttempt(): AttemptAuthorization {
    const attemptNumber = this.invocationsStarted + 1;
    const refuse = (reason: AttemptRefusalReason, detail: string): AttemptAuthorization => {
      this.invocationsRefused += 1;
      return {
        allowed: false,
        attemptBudgetUsd: 0,
        attemptTimeoutMs: 0,
        attemptNumber,
        reason,
        detail,
      };
    };

    if (this.invocationsStarted >= this.config.maxProviderInvocations) {
      return refuse(
        "INVOCATION_CEILING_REACHED",
        `this run is limited to ${this.config.maxProviderInvocations} provider invocation(s) and has already started ${this.invocationsStarted}`,
      );
    }
    const remainingTimeMs = this.remainingRunTimeMs();
    if (remainingTimeMs < this.minimumAttemptTimeMs) {
      return refuse(
        "RUN_DEADLINE_EXHAUSTED",
        `only ${remainingTimeMs}ms remain of the ${this.config.runTimeoutMs}ms run deadline, below the ${this.minimumAttemptTimeMs}ms minimum`,
      );
    }
    const remainingBudget = this.remainingRunBudgetUsd();
    if (remainingBudget === null) {
      return refuse(
        "REMAINING_BUDGET_UNKNOWN",
        "a previous attempt did not report its cost, so the remaining run budget is unknown; " +
          "failing closed rather than authorizing a billed attempt against an unmeasured ceiling",
      );
    }
    if (remainingBudget < this.minimumAttemptBudgetUsd) {
      return refuse(
        "RUN_BUDGET_EXHAUSTED",
        `only $${remainingBudget.toFixed(4)} remains of the $${this.config.runBudgetUsd} run budget, below the $${this.minimumAttemptBudgetUsd} minimum`,
      );
    }

    this.invocationsStarted += 1;
    return {
      allowed: true,
      attemptBudgetUsd: remainingBudget,
      attemptTimeoutMs: remainingTimeMs,
      attemptNumber,
    };
  }

  /** Records what an attempt actually consumed. Called once per started attempt, after it ends. */
  recordAttemptSpend(spend: AttemptSpend): void {
    this.spends.push({ ...spend });
  }

  /** Aggregate across every attempt. A failed attempt's cost is never dropped because a later one succeeded. */
  totals(): RunCostTotals {
    const known = this.spends.filter((spend) => spend.costUsd !== null);
    const unknown = this.spends.length - known.length;
    const costStatus: RunCostTotals["costStatus"] =
      this.spends.length === 0 || unknown === this.spends.length
        ? "UNKNOWN"
        : unknown > 0
          ? "PARTIAL"
          : "KNOWN";
    return {
      knownCostUsd: known.reduce((total, spend) => total + (spend.costUsd ?? 0), 0),
      attemptsWithKnownCost: known.length,
      attemptsWithUnknownCost: unknown,
      inputTokens: this.spends.reduce((total, spend) => total + spend.inputTokens, 0),
      outputTokens: this.spends.reduce((total, spend) => total + spend.outputTokens, 0),
      cachedTokens: this.spends.reduce((total, spend) => total + spend.cachedTokens, 0),
      costStatus,
    };
  }
}
