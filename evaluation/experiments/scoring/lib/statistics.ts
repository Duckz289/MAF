// The frozen statistical plan (EXPERIMENT_PROTOCOL.md sections 15.1-15.3), implemented ONLY as far
// as the frozen text actually determines it.
//
// The protocol was pre-registered before any result was seen; that is what makes it evidence rather
// than a story fitted to data. It follows that this module may not fill a gap in the plan with a
// reasonable-looking choice after the fact, because a post-hoc analytic choice is exactly the
// degree of freedom pre-registration exists to remove. Where the frozen text determines the method,
// it is implemented exactly. Where it does not, the function returns an UNDERSPECIFIED result
// naming the ambiguity, and the caller reports it for a protocol-level decision.
//
// Three such gaps exist and are documented at `KNOWN_STATISTICAL_AMBIGUITIES` below. Their
// pre-scoring resolution is frozen separately as Analysis v1
// (evaluation/experiments/EXPERIMENT_ANALYSIS_V1.md, tag maf-experiment-analysis-v1) and must not
// be inlined here as a silent rewrite of Protocol v2.
//
// SUPERSEDED FOR ANALYSIS. Since Analysis v1 was frozen, the scoring runner computes every reported
// number through `evaluation/experiments/analysis/analysis-v1.ts`, reached via
// `scoring/lib/analysis-binding.ts`. `analyzeScoringRuns` below is NOT wired into any campaign and
// must not be: two analysis implementations could drift, and only the frozen one governs. What
// remains valuable here is the record of WHICH questions the protocol left open, which is why the
// module is kept rather than deleted.

import type { Arm } from "./schedule";

// ---------------------------------------------------------------- primitives

export interface Interval {
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for a SINGLE binomial proportion. Unambiguous and fully specified.
 *
 *   center = (p̂ + z²/2n) / (1 + z²/n)
 *   half   = z/(1 + z²/n) · sqrt( p̂(1-p̂)/n + z²/4n² )
 */
export const wilsonScoreInterval = (
  successes: number,
  n: number,
  z = 1.959963984540054,
): Interval => {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || n < 0) {
    throw new Error("wilsonScoreInterval requires non-negative integer successes and n");
  }
  if (successes > n) throw new Error("wilsonScoreInterval requires successes <= n");
  if (n === 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
};

/** Exact binomial coefficient via a multiplicative recurrence; exact for the n<=29 used here. */
export const binomialCoefficient = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) result = (result * (n - kk + i)) / i;
  return Math.round(result);
};

export interface McNemarResult {
  /** MAF passed, Native failed. */
  mafOnlyPass: number;
  /** Native passed, MAF failed. */
  nativeOnlyPass: number;
  discordantPairs: number;
  /** Two-sided exact binomial p-value on the discordant pairs against p=0.5. */
  pValue: number;
  method: "EXACT_BINOMIAL_TWO_SIDED";
  detail: string;
}

/**
 * McNemar's test via the exact binomial p-value on discordant pairs, as section 15.3 specifies
 * ("Report the exact binomial p-value on the discordant pairs").
 *
 * Under H0 each discordant pair is equally likely to favour either arm, so the discordant counts are
 * Binomial(n, 0.5). That distribution is symmetric, which is why the two-sided p-value here is
 * unambiguous: the doubling convention and the minimum-likelihood convention coincide at p=0.5.
 */
export const mcNemarExactTest = (mafOnlyPass: number, nativeOnlyPass: number): McNemarResult => {
  if (
    !Number.isInteger(mafOnlyPass) ||
    !Number.isInteger(nativeOnlyPass) ||
    mafOnlyPass < 0 ||
    nativeOnlyPass < 0
  ) {
    throw new Error("mcNemarExactTest requires non-negative integer discordant counts");
  }
  const n = mafOnlyPass + nativeOnlyPass;
  if (n === 0) {
    return {
      mafOnlyPass,
      nativeOnlyPass,
      discordantPairs: 0,
      pValue: 1,
      method: "EXACT_BINOMIAL_TWO_SIDED",
      detail:
        "no discordant pairs: every task-level pair agreed, so the paired test has no information " +
        "and the p-value is 1 by construction (this is not evidence of equivalence)",
    };
  }
  const m = Math.min(mafOnlyPass, nativeOnlyPass);
  let tail = 0;
  for (let i = 0; i <= m; i += 1) tail += binomialCoefficient(n, i);
  const pValue = Math.min(1, (2 * tail) / 2 ** n);
  return {
    mafOnlyPass,
    nativeOnlyPass,
    discordantPairs: n,
    pValue,
    method: "EXACT_BINOMIAL_TWO_SIDED",
    detail: `exact two-sided binomial on ${n} discordant pair(s) against p=0.5`,
  };
};

// ------------------------------------------------- underspecification model

export interface StatisticalAmbiguity {
  id: string;
  topic: string;
  frozenTextSays: string;
  whyUnderspecified: string;
  candidateInterpretations: string[];
  consequence: string;
}

export const KNOWN_STATISTICAL_AMBIGUITIES: readonly StatisticalAmbiguity[] = [
  {
    id: "MAJORITY_OF_3_WITH_INVALID_REPETITIONS",
    topic: "Task-level majority aggregation when 1 or 2 of the 3 repetitions are invalid",
    frozenTextSays:
      "EXPERIMENT_PROTOCOL.md 15.1: \"an arm's 3 repetitions for a task collapse to a single " +
      "task-level outcome by majority vote (>=2 of 3 DVS -> task-level DVS=true). A 3-way split " +
      'cannot occur with an odd N." and "Task-level invalid: if ALL 3 repetitions for an arm are ' +
      'invalid, the task-arm cell is INVALID..."',
    whyUnderspecified:
      "Only the all-3-valid and all-3-invalid cases are defined. Section 17.2 explicitly " +
      'contemplates the intermediate case ("the task-arm cell is reported with reduced N and that ' +
      'reduction is disclosed"), so a cell with 1 or 2 valid repetitions is reachable, not ' +
      "hypothetical. The plan does not say whether the >=2 threshold is retained literally or " +
      "recomputed over the valid subset, and 15.1's assurance that ties cannot occur relies on all " +
      "three repetitions counting.",
    candidateInterpretations: [
      'Retain ">=2 of 3" literally: a cell with 1 valid DVS run and 2 invalid runs is a VALID ' +
        "non-DVS cell. This makes an arm's task-level result worse because of infrastructure " +
        'failures, contradicting section 17\'s rule that invalid runs "never count toward DVS" and ' +
        "are excluded from the valid-run denominator.",
      "Recompute majority over the valid subset only: 1 of 1 valid DVS -> task-level DVS=true. " +
        "This restores 17's exclusion rule but leaves a 1-1 split at N=2 with no majority and no " +
        "tie-breaking rule anywhere in the frozen text.",
      "Treat any cell with fewer than 3 valid repetitions as itself invalid and exclude it from " +
        "the denominator. This is self-consistent but discards real data the protocol elsewhere " +
        'says should be "reported with reduced N", not dropped.',
    ],
    consequence:
      "The three readings give opposite task-level DVS values for the same observed data, which " +
      "propagates into the primary metric, the paired McNemar counts and the reported difference.",
  },
  {
    id: "WILSON_INTERVAL_ON_A_DIFFERENCE_OF_PAIRED_PROPORTIONS",
    topic: "Which Wilson-based method computes the CI on the aggregate DVS-rate difference",
    frozenTextSays:
      'EXPERIMENT_PROTOCOL.md 15.3: "...alongside a Wilson score 95% confidence interval on the ' +
      'aggregate DVS-rate difference."',
    whyUnderspecified:
      "The Wilson score interval is defined for a SINGLE proportion; it has no canonical extension " +
      "to a difference. The standard Wilson-based difference methods are Newcombe's square-and-add " +
      "(method 10), which assumes INDEPENDENT samples, and the Newcombe/Tango paired methods, which " +
      "incorporate the pair correlation. The same section explicitly requires the analysis be " +
      'PAIRED ("rather than an unpaired two-proportion test", because task difficulty would ' +
      "otherwise confound the arm effect), so the unpaired square-and-add form contradicts the " +
      "section's own stated rationale, while the paired form it implies is never named.",
    candidateInterpretations: [
      "Newcombe method 10 (square-and-add Wilson) for independent proportions — contradicts the " +
        "section's paired rationale.",
      "Newcombe's paired-data method (or Tango's score interval) incorporating the discordant " +
        "counts — consistent with the pairing rationale but not named in the frozen text.",
      "Two separate per-arm Wilson intervals reported side by side, with no interval on the " +
        "difference itself — the most literal reading of 'Wilson score interval', but it does not " +
        "deliver an interval 'on the aggregate DVS-rate difference' as written.",
    ],
    consequence:
      "The methods yield materially different widths on the same data (the paired form is typically " +
      "narrower when the arms are positively correlated across tasks, which they will be, since both " +
      "arms face the same task difficulty), so the choice can change whether the interval excludes 0.",
  },
  {
    id: "DIFFERENCE_BETWEEN_RATES_WITH_UNEQUAL_DENOMINATORS",
    topic: "Pairing unit for the difference when the two arms have different valid-cell counts",
    frozenTextSays:
      'EXPERIMENT_PROTOCOL.md 15.2: aggregate DVS rate per arm is "task-level DVS successes / ' +
      'task-level valid cells", and the difference is "MAF aggregate rate minus Native aggregate rate".',
    whyUnderspecified:
      "Each arm's denominator is its OWN count of valid task-level cells. If an infrastructure " +
      "failure invalidates a cell in one arm only, the two rates are computed over different task " +
      "sets, and their difference is no longer a paired quantity over a common set of tasks. No " +
      "paired interval or paired test is defined over mismatched denominators, and the frozen text " +
      "does not say whether to restrict both arms to the tasks valid in BOTH arms (complete-case " +
      "pairing) or to keep the per-arm denominators as written.",
    candidateInterpretations: [
      "Complete-case pairing: restrict both arms to tasks whose cells are valid in both, so the " +
        "difference and the McNemar counts share one task set.",
      "Keep per-arm denominators exactly as 15.2 words it, accepting that the reported difference " +
        "is then between two rates over different task sets.",
    ],
    consequence:
      "Changes both the point estimate of the difference and which tasks enter the paired test; the " +
      "two readings can disagree in sign when invalidation is asymmetric across arms.",
  },
];

export type Determined<T> = { status: "DETERMINED"; value: T };
export type Underspecified = {
  status: "UNDERSPECIFIED";
  ambiguity: StatisticalAmbiguity;
  detail: string;
};
export type MaybeDetermined<T> = Determined<T> | Underspecified;

const determined = <T>(value: T): Determined<T> => ({ status: "DETERMINED", value });
const underspecified = (id: string, detail: string): Underspecified => {
  const ambiguity = KNOWN_STATISTICAL_AMBIGUITIES.find((a) => a.id === id);
  if (!ambiguity) throw new Error(`unknown statistical ambiguity id ${id}`);
  return { status: "UNDERSPECIFIED", ambiguity, detail };
};

// --------------------------------------------------- run and cell modelling

/** The minimum a single scoring observation must expose for the frozen analysis. */
export interface ScoringRunSummary {
  taskId: string;
  arm: Arm;
  replicate: number;
  /** Effective validity after downgrade; an infrastructure failure is always INVALID. */
  runValidity: "VALID" | "INVALID";
  infrastructureInvalid: boolean;
  dvs: boolean;
  falseSafe: boolean;
  hiddenGraderPass: boolean;
  regressionPass: boolean;
  candidateIntegrityValid: boolean;
  costUsd: number | null;
  costStatus: "KNOWN" | "PARTIAL" | "UNKNOWN";
  elapsedMs: number;
  mafInterventions?: number;
  retries?: number;
}

export interface TaskArmCell {
  taskId: string;
  arm: Arm;
  runs: ScoringRunSummary[];
  validRuns: number;
  dvsRuns: number;
  /** DETERMINED only where the frozen plan actually determines it. */
  taskLevelDvs: MaybeDetermined<boolean>;
  /** True when every repetition was invalid: the cell itself is invalid (15.1, explicit). */
  cellInvalid: boolean;
  /** Mean cost across valid repetitions; null when no valid repetition reported a cost. */
  meanCostUsd: number | null;
  costStatus: "KNOWN" | "PARTIAL" | "UNKNOWN";
  meanElapsedMs: number | null;
  reducedN: boolean;
}

/**
 * Collapses one task-arm cell's repetitions to a single task-level outcome (section 15.1).
 *
 * `runsPerTask` is passed rather than assumed so the "all repetitions invalid" and "reduced N"
 * conditions are evaluated against the frozen N rather than against however many records happen to
 * exist -- a cell missing a record is reduced-N, not a smaller experiment.
 */
export const aggregateTaskArmCell = (
  taskId: string,
  arm: Arm,
  runs: readonly ScoringRunSummary[],
  runsPerTask: number,
): TaskArmCell => {
  const ordered = [...runs].sort((a, b) => a.replicate - b.replicate);
  const valid = ordered.filter((run) => run.runValidity === "VALID");
  const dvsRuns = valid.filter((run) => run.dvs).length;
  const cellInvalid = ordered.length > 0 && valid.length === 0;

  const costKnown = valid.filter((r) => r.costStatus === "KNOWN" && typeof r.costUsd === "number");
  const costUnknown = valid.length - costKnown.length;
  const meanCostUsd =
    costKnown.length === 0
      ? null
      : costKnown.reduce((total, r) => total + (r.costUsd ?? 0), 0) / costKnown.length;
  const costStatus: TaskArmCell["costStatus"] =
    valid.length === 0 || costKnown.length === 0
      ? "UNKNOWN"
      : costUnknown > 0
        ? "PARTIAL"
        : "KNOWN";
  const meanElapsedMs =
    valid.length === 0 ? null : valid.reduce((total, r) => total + r.elapsedMs, 0) / valid.length;

  let taskLevelDvs: MaybeDetermined<boolean>;
  if (cellInvalid) {
    // Explicitly defined by 15.1: all repetitions invalid -> the cell is invalid.
    taskLevelDvs = underspecified(
      "MAJORITY_OF_3_WITH_INVALID_REPETITIONS",
      `task ${taskId} arm ${arm}: every repetition is invalid, so the cell is INVALID and carries ` +
        "no task-level DVS value; it is excluded from the valid-cell denominator",
    );
  } else if (valid.length === runsPerTask) {
    // The fully-specified case: strict majority of the frozen odd N.
    taskLevelDvs = determined(dvsRuns * 2 > runsPerTask);
  } else {
    taskLevelDvs = underspecified(
      "MAJORITY_OF_3_WITH_INVALID_REPETITIONS",
      `task ${taskId} arm ${arm}: ${valid.length} of ${runsPerTask} repetitions are valid ` +
        `(${dvsRuns} DVS). The frozen plan defines majority only for all-${runsPerTask}-valid and ` +
        "all-invalid cells, and the competing readings disagree for this cell.",
    );
  }

  return {
    taskId,
    arm,
    runs: ordered,
    validRuns: valid.length,
    dvsRuns,
    taskLevelDvs,
    cellInvalid,
    meanCostUsd,
    costStatus,
    meanElapsedMs,
    // A cell with no records at all has simply not run yet; that is not "reduced N", which means a
    // cell that ran but lost repetitions to infrastructure failure (section 17.2).
    reducedN: ordered.length > 0 && !cellInvalid && valid.length !== runsPerTask,
  };
};

// ------------------------------------------------------- global aggregation

export interface ArmAggregate {
  arm: Arm;
  /** Cells whose task-level DVS the frozen plan determines. */
  determinedCells: number;
  dvsCells: number;
  invalidCells: number;
  /** Cells the frozen plan does not determine; never silently folded into either count. */
  underspecifiedCells: number;
  /** DVS_RATE_AMONG_VALID_RUNS at task level. Null when no cell is determined. */
  dvsRate: number | null;
  /** Wilson 95% CI on this arm's own rate. Single-proportion Wilson is unambiguous. */
  dvsRateInterval: Interval | null;
}

export type TaskPairOutcome =
  | "BOTH_PASS"
  | "MAF_ONLY_PASS"
  | "NATIVE_ONLY_PASS"
  | "BOTH_FAIL"
  | "INVALID_NATIVE"
  | "INVALID_MAF"
  | "INVALID_BOTH"
  | "UNDETERMINED";

export interface TaskPair {
  taskId: string;
  native: TaskArmCell;
  maf: TaskArmCell;
  outcome: TaskPairOutcome;
}

/** Post-aggregation pairing (15.2), applied to task-level cells rather than raw runs. */
export const classifyTaskPair = (native: TaskArmCell, maf: TaskArmCell): TaskPairOutcome => {
  if (native.cellInvalid && maf.cellInvalid) return "INVALID_BOTH";
  if (native.cellInvalid) return "INVALID_NATIVE";
  if (maf.cellInvalid) return "INVALID_MAF";
  if (native.taskLevelDvs.status !== "DETERMINED" || maf.taskLevelDvs.status !== "DETERMINED") {
    return "UNDETERMINED";
  }
  const n = native.taskLevelDvs.value;
  const m = maf.taskLevelDvs.value;
  if (n && m) return "BOTH_PASS";
  if (m) return "MAF_ONLY_PASS";
  if (n) return "NATIVE_ONLY_PASS";
  return "BOTH_FAIL";
};

export interface SecondaryMetrics {
  costPerDvsUsd: { native: number | null; maf: number | null };
  costStatus: { native: "KNOWN" | "PARTIAL" | "UNKNOWN"; maf: "KNOWN" | "PARTIAL" | "UNKNOWN" };
  meanElapsedOfDvsCellsMs: { native: number | null; maf: number | null };
  invalidRunRate: { native: number | null; maf: number | null };
  hiddenGraderPassRate: { native: number | null; maf: number | null };
  regressionPassRate: { native: number | null; maf: number | null };
  candidateIntegrityFailureRate: { native: number | null; maf: number | null };
  falseSafeRateAmongValidRuns: { native: number | null; maf: number | null };
  mafInterventionCount: number;
  retryCount: { native: number; maf: number };
  totalWallClockMs: number;
  knownSpendUsd: number;
  runsWithUnknownCost: number;
}

export interface ScoringAnalysis {
  reportStatus: "PROVISIONAL" | "FINAL";
  /** Loud, machine-readable marker; interim numbers must never drive a stopping decision. */
  stoppingDecisionUse: "NOT_FOR_STOPPING_DECISIONS";
  completedSlots: number;
  expectedSlots: number;
  pairs: TaskPair[];
  native: ArmAggregate;
  maf: ArmAggregate;
  /** Determined only when both arms' rates are determined AND denominators match. */
  dvsRateDifference: MaybeDetermined<number>;
  dvsRateDifferenceInterval: Underspecified;
  mcNemar: MaybeDetermined<McNemarResult>;
  relativeImprovement: number | null;
  secondary: SecondaryMetrics;
  underspecified: StatisticalAmbiguity[];
  notes: string[];
}

const rate = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const aggregateArm = (cells: readonly TaskArmCell[], arm: Arm): ArmAggregate => {
  const armCells = cells.filter((cell) => cell.arm === arm);
  const determinedCells = armCells.filter((c) => c.taskLevelDvs.status === "DETERMINED");
  const dvsCells = determinedCells.filter(
    (c) => c.taskLevelDvs.status === "DETERMINED" && c.taskLevelDvs.value,
  ).length;
  const invalidCells = armCells.filter((c) => c.cellInvalid).length;
  const underspecifiedCells = armCells.filter(
    (c) => c.taskLevelDvs.status !== "DETERMINED" && !c.cellInvalid,
  ).length;
  const dvsRate = rate(dvsCells, determinedCells.length);
  return {
    arm,
    determinedCells: determinedCells.length,
    dvsCells,
    invalidCells,
    underspecifiedCells,
    dvsRate,
    dvsRateInterval:
      determinedCells.length === 0 ? null : wilsonScoreInterval(dvsCells, determinedCells.length),
  };
};

const computeSecondary = (
  runs: readonly ScoringRunSummary[],
  cells: readonly TaskArmCell[],
): SecondaryMetrics => {
  const forArm = (arm: Arm) => runs.filter((r) => r.arm === arm);
  const validFor = (arm: Arm) => forArm(arm).filter((r) => r.runValidity === "VALID");

  const costPerDvs = (
    arm: Arm,
  ): { value: number | null; status: "KNOWN" | "PARTIAL" | "UNKNOWN" } => {
    const armCells = cells.filter((c) => c.arm === arm);
    const dvsCells = armCells.filter(
      (c) => c.taskLevelDvs.status === "DETERMINED" && c.taskLevelDvs.value,
    );
    const withCost = armCells.filter((c) => typeof c.meanCostUsd === "number");
    const known = withCost.reduce((total, c) => total + (c.meanCostUsd ?? 0), 0);
    const anyUnknown = armCells.some((c) => c.costStatus !== "KNOWN");
    if (dvsCells.length === 0) return { value: null, status: anyUnknown ? "PARTIAL" : "KNOWN" };
    return {
      value: known / dvsCells.length,
      status: anyUnknown ? "PARTIAL" : "KNOWN",
    };
  };

  const meanElapsedDvs = (arm: Arm): number | null => {
    const dvsCells = cells.filter(
      (c) =>
        c.arm === arm &&
        c.taskLevelDvs.status === "DETERMINED" &&
        c.taskLevelDvs.value &&
        typeof c.meanElapsedMs === "number",
    );
    if (dvsCells.length === 0) return null;
    return dvsCells.reduce((t, c) => t + (c.meanElapsedMs ?? 0), 0) / dvsCells.length;
  };

  const nativeCost = costPerDvs("NATIVE");
  const mafCost = costPerDvs("MAF");

  const passRate = (arm: Arm, predicate: (r: ScoringRunSummary) => boolean): number | null => {
    const valid = validFor(arm);
    return rate(valid.filter(predicate).length, valid.length);
  };

  return {
    costPerDvsUsd: { native: nativeCost.value, maf: mafCost.value },
    costStatus: { native: nativeCost.status, maf: mafCost.status },
    meanElapsedOfDvsCellsMs: { native: meanElapsedDvs("NATIVE"), maf: meanElapsedDvs("MAF") },
    invalidRunRate: {
      native: rate(
        forArm("NATIVE").filter((r) => r.runValidity === "INVALID").length,
        forArm("NATIVE").length,
      ),
      maf: rate(
        forArm("MAF").filter((r) => r.runValidity === "INVALID").length,
        forArm("MAF").length,
      ),
    },
    hiddenGraderPassRate: {
      native: passRate("NATIVE", (r) => r.hiddenGraderPass),
      maf: passRate("MAF", (r) => r.hiddenGraderPass),
    },
    regressionPassRate: {
      native: passRate("NATIVE", (r) => r.regressionPass),
      maf: passRate("MAF", (r) => r.regressionPass),
    },
    candidateIntegrityFailureRate: {
      native: passRate("NATIVE", (r) => !r.candidateIntegrityValid),
      maf: passRate("MAF", (r) => !r.candidateIntegrityValid),
    },
    falseSafeRateAmongValidRuns: {
      native: passRate("NATIVE", (r) => r.falseSafe),
      maf: passRate("MAF", (r) => r.falseSafe),
    },
    mafInterventionCount: forArm("MAF").reduce((t, r) => t + (r.mafInterventions ?? 0), 0),
    retryCount: {
      native: forArm("NATIVE").reduce((t, r) => t + (r.retries ?? 0), 0),
      maf: forArm("MAF").reduce((t, r) => t + (r.retries ?? 0), 0),
    },
    totalWallClockMs: runs.reduce((t, r) => t + r.elapsedMs, 0),
    knownSpendUsd: runs
      .filter((r) => r.costStatus === "KNOWN" && typeof r.costUsd === "number")
      .reduce((t, r) => t + (r.costUsd ?? 0), 0),
    runsWithUnknownCost: runs.filter((r) => r.costStatus !== "KNOWN").length,
  };
};

export interface AnalyzeInput {
  runs: readonly ScoringRunSummary[];
  taskIds: readonly string[];
  runsPerTask: number;
  expectedSlots: number;
  /** FINAL is permitted only when the frozen completion conditions are satisfied. */
  allowFinal?: boolean;
}

/**
 * Runs the frozen analysis over whatever observations exist.
 *
 * The report is PROVISIONAL unless every expected slot is present AND the caller explicitly permits
 * a final report. Section 18 forbids stopping early on a trend, so an interim analysis exists only
 * to show operational progress and is labelled so it cannot be mistaken for a result.
 */
export const analyzeScoringRuns = (input: AnalyzeInput): ScoringAnalysis => {
  const { runs, taskIds, runsPerTask } = input;
  const cells: TaskArmCell[] = [];
  for (const taskId of taskIds) {
    for (const arm of ["NATIVE", "MAF"] as const) {
      const cellRuns = runs.filter((r) => r.taskId === taskId && r.arm === arm);
      cells.push(aggregateTaskArmCell(taskId, arm, cellRuns, runsPerTask));
    }
  }

  const pairs: TaskPair[] = taskIds.map((taskId) => {
    const native = cells.find((c) => c.taskId === taskId && c.arm === "NATIVE") as TaskArmCell;
    const maf = cells.find((c) => c.taskId === taskId && c.arm === "MAF") as TaskArmCell;
    return { taskId, native, maf, outcome: classifyTaskPair(native, maf) };
  });

  const native = aggregateArm(cells, "NATIVE");
  const maf = aggregateArm(cells, "MAF");

  const anyUndetermined = pairs.some((p) => p.outcome === "UNDETERMINED");
  const mcNemar: MaybeDetermined<McNemarResult> = anyUndetermined
    ? underspecified(
        "MAJORITY_OF_3_WITH_INVALID_REPETITIONS",
        `${pairs.filter((p) => p.outcome === "UNDETERMINED").length} task pair(s) have an ` +
          "undetermined task-level outcome, so the discordant counts the paired test needs cannot " +
          "be formed without first resolving the aggregation rule",
      )
    : determined(
        mcNemarExactTest(
          pairs.filter((p) => p.outcome === "MAF_ONLY_PASS").length,
          pairs.filter((p) => p.outcome === "NATIVE_ONLY_PASS").length,
        ),
      );

  // The point difference is reportable only when both rates exist over the SAME denominator; the
  // unequal-denominator case is itself one of the documented ambiguities.
  let dvsRateDifference: MaybeDetermined<number>;
  if (native.dvsRate === null || maf.dvsRate === null) {
    dvsRateDifference = underspecified(
      "MAJORITY_OF_3_WITH_INVALID_REPETITIONS",
      "at least one arm has no determined task-level cell, so its aggregate rate does not exist",
    );
  } else if (native.determinedCells !== maf.determinedCells) {
    dvsRateDifference = underspecified(
      "DIFFERENCE_BETWEEN_RATES_WITH_UNEQUAL_DENOMINATORS",
      `NATIVE has ${native.determinedCells} determined cells and MAF has ${maf.determinedCells}; ` +
        "the frozen plan does not say whether to pair complete cases or keep per-arm denominators",
    );
  } else {
    dvsRateDifference = determined(maf.dvsRate - native.dvsRate);
  }

  const relativeImprovement =
    native.dvsRate === null || maf.dvsRate === null || native.dvsRate === 0
      ? null
      : (maf.dvsRate - native.dvsRate) / native.dvsRate;

  const completedSlots = runs.length;
  const complete = completedSlots === input.expectedSlots;
  const underspecifiedSet = new Map<string, StatisticalAmbiguity>();
  for (const cell of cells) {
    if (cell.taskLevelDvs.status === "UNDERSPECIFIED") {
      underspecifiedSet.set(cell.taskLevelDvs.ambiguity.id, cell.taskLevelDvs.ambiguity);
    }
  }
  if (dvsRateDifference.status === "UNDERSPECIFIED") {
    underspecifiedSet.set(dvsRateDifference.ambiguity.id, dvsRateDifference.ambiguity);
  }
  const differenceInterval = underspecified(
    "WILSON_INTERVAL_ON_A_DIFFERENCE_OF_PAIRED_PROPORTIONS",
    "the frozen plan names a Wilson score interval on the aggregate DVS-rate difference without " +
      "specifying which Wilson-based difference method, and its own pairing rationale rules out the " +
      "standard independent-samples form",
  );
  underspecifiedSet.set(differenceInterval.ambiguity.id, differenceInterval.ambiguity);

  const notes: string[] = [];
  if (!complete) {
    notes.push(
      `${completedSlots} of ${input.expectedSlots} scoring observations are present; this analysis ` +
        "is PROVISIONAL and must not inform any stopping decision (EXPERIMENT_PROTOCOL.md 18).",
    );
  }
  const reducedCells = cells.filter((c) => c.reducedN);
  if (reducedCells.length > 0) {
    notes.push(
      `${reducedCells.length} task-arm cell(s) have reduced N; section 17.2 requires this reduction ` +
        "be disclosed rather than hidden.",
    );
  }

  return {
    reportStatus: complete && input.allowFinal === true ? "FINAL" : "PROVISIONAL",
    stoppingDecisionUse: "NOT_FOR_STOPPING_DECISIONS",
    completedSlots,
    expectedSlots: input.expectedSlots,
    pairs,
    native,
    maf,
    dvsRateDifference,
    dvsRateDifferenceInterval: differenceInterval,
    mcNemar,
    relativeImprovement,
    secondary: computeSecondary(runs, cells),
    underspecified: [...underspecifiedSet.values()],
    notes,
  };
};
