// Frozen pre-scoring analysis specification v1.
//
// Canonical text: evaluation/experiments/EXPERIMENT_ANALYSIS_V1.md
// Machine-readable: evaluation/experiments/experiment-analysis-v1.json
//
// This module is the executable reference for the three statistical decisions
// Protocol v1/v2 left underspecified. It does not modify Protocol v2. It does
// not redefine DVS, arms, N, invalid-run policy, or the primary run-level
// metric. It must not be fed frontier scoring results during its own freeze.

export const ANALYSIS_TAG = "maf-experiment-analysis-v1";
export const ANALYSIS_VERSION = "1.0.0";
export const ANALYSIS_STATUS = "FROZEN_PRE_SCORING";

export const SUITE_TAG = "maf-suite-freeze-v1";
export const SUITE_SHA = "92f13ae67802dd0049ca001f70839a9451120900";
export const PROTOCOL_V1_TAG = "maf-experiment-protocol-v1";
export const PROTOCOL_V1_SHA = "b183b20a08b1d4f6902bffea49fe139f80cad4e9";
export const PROTOCOL_V2_TAG = "maf-experiment-protocol-v2";
export const PROTOCOL_V2_SHA = "b086b21e1e66f4a3c039d5c60079d9311eb82e15";

/** Two-sided 95% standard-normal quantile. Shared by every Wilson-derived quantity. */
export const WILSON_Z_95 = 1.959963984540054;
export const CONFIDENCE_LEVEL = 0.95;
export const PLANNED_REPETITIONS = 3;

export type Arm = "NATIVE" | "MAF";

export interface Interval {
  lower: number;
  upper: number;
}

export interface Observation {
  taskId: string;
  arm: Arm;
  replicate: number;
  runValidity: "VALID" | "INVALID";
  dvs: boolean;
}

export type CellStatus = "DETERMINATE" | "UNRESOLVED" | "INVALID_CELL" | "UNOBSERVED";

export interface TaskArmCell {
  taskId: string;
  arm: Arm;
  plannedRepetitions: typeof PLANNED_REPETITIONS;
  observedRepetitions: number;
  validObservations: number;
  invalidObservations: number;
  /** DVS successes among VALID observations only. Invalid runs never contribute. */
  dvsSuccessesAmongValid: number;
  status: CellStatus;
  /** Present only when status is DETERMINATE. */
  binaryOutcome: boolean | null;
  reducedN: boolean;
  unresolvedReason: string | null;
}

export type PairExclusionReason =
  | "UNOBSERVED_NATIVE"
  | "UNOBSERVED_MAF"
  | "UNOBSERVED_BOTH"
  | "INVALID_NATIVE"
  | "INVALID_MAF"
  | "INVALID_BOTH"
  | "UNRESOLVED_NATIVE"
  | "UNRESOLVED_MAF"
  | "UNRESOLVED_BOTH"
  | "MIXED_INELIGIBLE";

export type PairClassification =
  | "BOTH_PASS"
  | "MAF_ONLY_PASS"
  | "NATIVE_ONLY_PASS"
  | "BOTH_FAIL"
  | "EXCLUDED";

export interface TaskPair {
  taskId: string;
  native: TaskArmCell;
  maf: TaskArmCell;
  eligible: boolean;
  classification: PairClassification;
  exclusionReason: PairExclusionReason | null;
}

export interface McNemarExactResult {
  n11: number;
  n10: number;
  n01: number;
  n00: number;
  discordantPairs: number;
  pValue: number;
  method: "EXACT_BINOMIAL_TWO_SIDED_P_EQUALS_HALF";
  zeroDiscordance: boolean;
  detail: string;
}

export type PairedDifferenceCi =
  | {
      status: "DETERMINED";
      estimate: number;
      lower: number;
      upper: number;
      nPairs: number;
      nativeRate: number;
      mafRate: number;
      phiRaw: number;
      phiUsed: number;
      continuityCorrectedPhi: boolean;
      method: "NEWCOMBE_1998_STAT_MED_17_2635_METHOD_10";
      confidenceLevel: typeof CONFIDENCE_LEVEL;
      z: number;
      detail: string;
    }
  | {
      status: "INAPPLICABLE";
      method: "NEWCOMBE_1998_STAT_MED_17_2635_METHOD_10";
      reason: string;
    };

export interface RunLevelArmMetric {
  arm: Arm;
  validRuns: number;
  invalidRuns: number;
  dvsCount: number;
  rate: number | null;
  wilsonInterval: Interval | null;
}

export interface TaskLevelArmDescriptive {
  arm: Arm;
  determinateCells: number;
  dvsCells: number;
  invalidCells: number;
  unresolvedCells: number;
  unobservedCells: number;
  rate: number | null;
  wilsonInterval: Interval | null;
}

export interface AnalysisV1Report {
  analysisTag: typeof ANALYSIS_TAG;
  analysisVersion: typeof ANALYSIS_VERSION;
  reportStatus: "PROVISIONAL" | "FINAL";
  stoppingDecisionUse: "NOT_FOR_STOPPING_DECISIONS";
  completedSlots: number;
  expectedSlots: number;
  pairs: TaskPair[];
  runLevel: { native: RunLevelArmMetric; maf: RunLevelArmMetric };
  taskLevelDescriptive: { native: TaskLevelArmDescriptive; maf: TaskLevelArmDescriptive };
  pairedInference: {
    eligibleTaskCount: number;
    excludedTaskCount: number;
    n11: number;
    n10: number;
    n01: number;
    n00: number;
    nativeRate: number | null;
    mafRate: number | null;
    difference: number | null;
    mcnemar: McNemarExactResult | null;
    differenceInterval: PairedDifferenceCi;
  };
  notes: string[];
}

export interface AnalyzeV1Input {
  observations: readonly Observation[];
  taskIds: readonly string[];
  runsPerTask?: number;
  expectedSlots: number;
  allowFinal?: boolean;
}

const requireNonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
};

/**
 * Wilson score interval for a single binomial proportion (Wilson 1927).
 * Closed form identical to the protocol-v2 runner's unambiguous single-proportion Wilson.
 */
export const wilsonScoreInterval = (successes: number, n: number, z = WILSON_Z_95): Interval => {
  requireNonNegativeInteger(successes, "successes");
  requireNonNegativeInteger(n, "n");
  if (successes > n) throw new Error("wilsonScoreInterval requires successes <= n");
  if (n === 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
};

/**
 * Independent Wilson construction: roots of |m - p̂| = z √(m(1-m)/n).
 * Used only as a cross-check that the closed form is the score interval.
 */
export const wilsonScoreIntervalQuadratic = (
  successes: number,
  n: number,
  z = WILSON_Z_95,
): Interval => {
  requireNonNegativeInteger(successes, "successes");
  requireNonNegativeInteger(n, "n");
  if (successes > n) throw new Error("wilsonScoreIntervalQuadratic requires successes <= n");
  if (n === 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const a = 1 + z2 / n;
  const b = -(2 * p + z2 / n);
  const c = p * p;
  const disc = Math.max(0, b * b - 4 * a * c);
  const root = Math.sqrt(disc);
  const m1 = (-b - root) / (2 * a);
  const m2 = (-b + root) / (2 * a);
  const lower = Math.min(m1, m2);
  const upper = Math.max(m1, m2);
  return { lower: Math.max(0, lower), upper: Math.min(1, upper) };
};

export const binomialCoefficient = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) result = (result * (n - kk + i)) / i;
  return Math.round(result);
};

/**
 * Two-sided exact McNemar test: exact binomial on discordant pairs under p=0.5.
 * Never switches to an asymptotic chi-square. Zero discordance => p=1, not equivalence.
 */
export const mcNemarExactTest = (
  n11: number,
  n10: number,
  n01: number,
  n00: number,
): McNemarExactResult => {
  for (const [label, value] of [
    ["n11", n11],
    ["n10", n10],
    ["n01", n01],
    ["n00", n00],
  ] as const) {
    requireNonNegativeInteger(value, label);
  }
  const discordantPairs = n10 + n01;
  if (discordantPairs === 0) {
    return {
      n11,
      n10,
      n01,
      n00,
      discordantPairs: 0,
      pValue: 1,
      method: "EXACT_BINOMIAL_TWO_SIDED_P_EQUALS_HALF",
      zeroDiscordance: true,
      detail:
        "zero discordant pairs: every eligible paired task agreed, so the paired test has no " +
        "information and the p-value is 1 by construction (this is not evidence of equivalence)",
    };
  }
  const m = Math.min(n10, n01);
  let tail = 0;
  for (let i = 0; i <= m; i += 1) tail += binomialCoefficient(discordantPairs, i);
  const pValue = Math.min(1, (2 * tail) / 2 ** discordantPairs);
  return {
    n11,
    n10,
    n01,
    n00,
    discordantPairs,
    pValue,
    method: "EXACT_BINOMIAL_TWO_SIDED_P_EQUALS_HALF",
    zeroDiscordance: false,
    detail: `exact two-sided binomial on ${discordantPairs} discordant pair(s) against p=0.5`,
  };
};

/**
 * Newcombe (1998) Statistics in Medicine 17:2635–2650, Method 10:
 * Wilson score intervals on the two paired marginal proportions, combined with a
 * continuity-corrected phi coefficient from the 2x2 table.
 *
 * Labelling (protocol difference = MAF rate − Native rate):
 *   n11 both DVS, n10 Native-only DVS, n01 MAF-only DVS, n00 both non-DVS.
 *   e=n11, f=n01, g=n10, h=n00, so θ̂ = (f−g)/n = (n01−n10)/n.
 */
export const newcombePairedDifferenceInterval = (
  n11: number,
  n10: number,
  n01: number,
  n00: number,
  z = WILSON_Z_95,
): PairedDifferenceCi => {
  for (const [label, value] of [
    ["n11", n11],
    ["n10", n10],
    ["n01", n01],
    ["n00", n00],
  ] as const) {
    requireNonNegativeInteger(value, label);
  }
  const n = n11 + n10 + n01 + n00;
  if (n === 0) {
    return {
      status: "INAPPLICABLE",
      method: "NEWCOMBE_1998_STAT_MED_17_2635_METHOD_10",
      reason: "no eligible paired tasks, so a paired-proportion interval cannot be formed",
    };
  }

  const e = n11;
  const f = n01;
  const g = n10;
  const h = n00;
  const pMaf = (e + f) / n;
  const pNative = (e + g) / n;
  const estimate = (f - g) / n;

  const mafWilson = wilsonScoreInterval(e + f, n, z);
  const nativeWilson = wilsonScoreInterval(e + g, n, z);

  const marginProduct = (e + f) * (g + h) * (e + g) * (f + h);
  const phiNumeratorRaw = e * h - f * g;
  const continuityCorrectedPhi = phiNumeratorRaw > 0;
  const phiNumeratorUsed = continuityCorrectedPhi
    ? Math.max(phiNumeratorRaw - n / 2, 0)
    : phiNumeratorRaw;
  const phiRaw = marginProduct === 0 ? 0 : phiNumeratorRaw / Math.sqrt(marginProduct);
  const phiUsed = marginProduct === 0 ? 0 : phiNumeratorUsed / Math.sqrt(marginProduct);

  const dlMaf = pMaf - mafWilson.lower;
  const duNative = nativeWilson.upper - pNative;
  const dlNative = pNative - nativeWilson.lower;
  const duMaf = mafWilson.upper - pMaf;

  const radLower = dlMaf * dlMaf - 2 * phiUsed * dlMaf * duNative + duNative * duNative;
  const radUpper = dlNative * dlNative - 2 * phiUsed * dlNative * duMaf + duMaf * duMaf;
  const lower = Math.max(-1, estimate - Math.sqrt(Math.max(0, radLower)));
  const upper = Math.min(1, estimate + Math.sqrt(Math.max(0, radUpper)));

  return {
    status: "DETERMINED",
    estimate,
    lower,
    upper,
    nPairs: n,
    nativeRate: pNative,
    mafRate: pMaf,
    phiRaw,
    phiUsed,
    continuityCorrectedPhi,
    method: "NEWCOMBE_1998_STAT_MED_17_2635_METHOD_10",
    confidenceLevel: CONFIDENCE_LEVEL,
    z,
    detail:
      "Newcombe 1998 Stat Med 17:2635-2650 method 10 (Wilson score intervals on paired " +
      "marginals with continuity-corrected phi). Difference is MAF minus Native.",
  };
};

const slotKey = (taskId: string, arm: Arm, replicate: number): string =>
  `${taskId}\0${arm}\0${replicate}`;

const assertUniqueSlots = (observations: readonly Observation[]): void => {
  const seen = new Set<string>();
  for (const observation of observations) {
    requireNonNegativeInteger(observation.replicate, "replicate");
    const key = slotKey(observation.taskId, observation.arm, observation.replicate);
    if (seen.has(key)) {
      throw new Error(
        `duplicate observation for task=${observation.taskId} arm=${observation.arm} ` +
          `replicate=${observation.replicate}`,
      );
    }
    seen.add(key);
  }
};

/**
 * Task × arm cell aggregation.
 *
 * 3 valid: ordinary majority (>=2 DVS among the 3).
 * 2 valid identical: that common DVS value (a majority is identifiable).
 * 2 valid split / 1 valid: UNRESOLVED (no identifiable majority; no imputation).
 * 0 valid with observations: INVALID_CELL.
 * 0 observations: UNOBSERVED.
 *
 * Infrastructure-invalid observations never become DVS=false and never enter the
 * valid-run or valid-cell DVS numerator.
 */
export const aggregateTaskArmCell = (
  taskId: string,
  arm: Arm,
  observations: readonly Observation[],
  plannedRepetitions = PLANNED_REPETITIONS,
): TaskArmCell => {
  const ordered = [...observations].sort((a, b) => a.replicate - b.replicate);
  const valid = ordered.filter((run) => run.runValidity === "VALID");
  const invalidObservations = ordered.length - valid.length;
  const dvsSuccessesAmongValid = valid.filter((run) => run.dvs).length;

  let status: CellStatus;
  let binaryOutcome: boolean | null = null;
  let unresolvedReason: string | null = null;

  if (ordered.length === 0) {
    status = "UNOBSERVED";
    unresolvedReason = "no observation has been recorded for this task-arm cell";
  } else if (valid.length === 0) {
    status = "INVALID_CELL";
    unresolvedReason = "every recorded observation is infrastructure-invalid";
  } else if (valid.length === plannedRepetitions) {
    status = "DETERMINATE";
    binaryOutcome = dvsSuccessesAmongValid * 2 > plannedRepetitions;
  } else if (valid.length === 2 && dvsSuccessesAmongValid === 2) {
    status = "DETERMINATE";
    binaryOutcome = true;
  } else if (valid.length === 2 && dvsSuccessesAmongValid === 0) {
    status = "DETERMINATE";
    binaryOutcome = false;
  } else if (valid.length === 2) {
    status = "UNRESOLVED";
    unresolvedReason =
      "2 valid observations split 1 DVS / 1 non-DVS; no majority is identifiable and none is imputed";
  } else {
    status = "UNRESOLVED";
    unresolvedReason =
      `${valid.length} valid observation(s) of ${plannedRepetitions} planned; a majority ` +
      "requires two agreeing valid DVS outcomes and is not identifiable";
  }

  return {
    taskId,
    arm,
    plannedRepetitions: PLANNED_REPETITIONS,
    observedRepetitions: ordered.length,
    validObservations: valid.length,
    invalidObservations,
    dvsSuccessesAmongValid,
    status,
    binaryOutcome,
    reducedN:
      ordered.length > 0 && valid.length !== plannedRepetitions && status !== "INVALID_CELL",
    unresolvedReason,
  };
};

const exclusionReason = (native: TaskArmCell, maf: TaskArmCell): PairExclusionReason => {
  if (native.status === "DETERMINATE" && maf.status === "DETERMINATE") {
    throw new Error("exclusionReason is only defined for ineligible pairs");
  }
  if (native.status === "UNOBSERVED" && maf.status === "UNOBSERVED") return "UNOBSERVED_BOTH";
  if (native.status === "UNOBSERVED") return "UNOBSERVED_NATIVE";
  if (maf.status === "UNOBSERVED") return "UNOBSERVED_MAF";
  if (native.status === "INVALID_CELL" && maf.status === "INVALID_CELL") return "INVALID_BOTH";
  if (native.status === "INVALID_CELL" && maf.status === "UNRESOLVED") return "MIXED_INELIGIBLE";
  if (maf.status === "INVALID_CELL" && native.status === "UNRESOLVED") return "MIXED_INELIGIBLE";
  if (native.status === "INVALID_CELL") return "INVALID_NATIVE";
  if (maf.status === "INVALID_CELL") return "INVALID_MAF";
  if (native.status === "UNRESOLVED" && maf.status === "UNRESOLVED") return "UNRESOLVED_BOTH";
  if (native.status === "UNRESOLVED") return "UNRESOLVED_NATIVE";
  return "UNRESOLVED_MAF";
};

export const classifyTaskPair = (native: TaskArmCell, maf: TaskArmCell): TaskPair => {
  if (native.status === "DETERMINATE" && maf.status === "DETERMINATE") {
    const n = native.binaryOutcome === true;
    const m = maf.binaryOutcome === true;
    let classification: PairClassification = "BOTH_FAIL";
    if (n && m) classification = "BOTH_PASS";
    else if (m) classification = "MAF_ONLY_PASS";
    else if (n) classification = "NATIVE_ONLY_PASS";
    return {
      taskId: native.taskId,
      native,
      maf,
      eligible: true,
      classification,
      exclusionReason: null,
    };
  }
  return {
    taskId: native.taskId,
    native,
    maf,
    eligible: false,
    classification: "EXCLUDED",
    exclusionReason: exclusionReason(native, maf),
  };
};

const rate = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const runLevelArm = (observations: readonly Observation[], arm: Arm): RunLevelArmMetric => {
  const forArm = observations.filter((o) => o.arm === arm);
  const valid = forArm.filter((o) => o.runValidity === "VALID");
  const dvsCount = valid.filter((o) => o.dvs).length;
  const validRuns = valid.length;
  return {
    arm,
    validRuns,
    invalidRuns: forArm.length - validRuns,
    dvsCount,
    rate: rate(dvsCount, validRuns),
    wilsonInterval: validRuns === 0 ? null : wilsonScoreInterval(dvsCount, validRuns),
  };
};

const taskLevelArm = (cells: readonly TaskArmCell[], arm: Arm): TaskLevelArmDescriptive => {
  const armCells = cells.filter((cell) => cell.arm === arm);
  const determinate = armCells.filter((c) => c.status === "DETERMINATE");
  const dvsCells = determinate.filter((c) => c.binaryOutcome === true).length;
  return {
    arm,
    determinateCells: determinate.length,
    dvsCells,
    invalidCells: armCells.filter((c) => c.status === "INVALID_CELL").length,
    unresolvedCells: armCells.filter((c) => c.status === "UNRESOLVED").length,
    unobservedCells: armCells.filter((c) => c.status === "UNOBSERVED").length,
    rate: rate(dvsCells, determinate.length),
    wilsonInterval:
      determinate.length === 0 ? null : wilsonScoreInterval(dvsCells, determinate.length),
  };
};

export const analyzeExperimentV1 = (input: AnalyzeV1Input): AnalysisV1Report => {
  const planned = input.runsPerTask ?? PLANNED_REPETITIONS;
  if (planned !== PLANNED_REPETITIONS) {
    throw new Error(`analysis v1 is frozen at N=${PLANNED_REPETITIONS} repetitions per task-arm`);
  }
  assertUniqueSlots(input.observations);
  for (const observation of input.observations) {
    if (!input.taskIds.includes(observation.taskId)) {
      throw new Error(
        `observation taskId ${observation.taskId} is not in the analysis task list ` +
          "(NON_SCORING / unknown tasks cannot enter analysis v1)",
      );
    }
  }

  const cells: TaskArmCell[] = [];
  for (const taskId of input.taskIds) {
    for (const arm of ["NATIVE", "MAF"] as const) {
      const cellRuns = input.observations.filter((r) => r.taskId === taskId && r.arm === arm);
      cells.push(aggregateTaskArmCell(taskId, arm, cellRuns, planned));
    }
  }

  const pairs: TaskPair[] = input.taskIds.map((taskId) => {
    const native = cells.find((c) => c.taskId === taskId && c.arm === "NATIVE");
    const maf = cells.find((c) => c.taskId === taskId && c.arm === "MAF");
    if (!native || !maf) throw new Error(`internal error: missing cell for ${taskId}`);
    return classifyTaskPair(native, maf);
  });

  const eligible = pairs.filter((p) => p.eligible);
  const n11 = eligible.filter((p) => p.classification === "BOTH_PASS").length;
  const n10 = eligible.filter((p) => p.classification === "NATIVE_ONLY_PASS").length;
  const n01 = eligible.filter((p) => p.classification === "MAF_ONLY_PASS").length;
  const n00 = eligible.filter((p) => p.classification === "BOTH_FAIL").length;
  const nPairs = n11 + n10 + n01 + n00;

  const mcnemar = nPairs === 0 ? null : mcNemarExactTest(n11, n10, n01, n00);
  const differenceInterval = newcombePairedDifferenceInterval(n11, n10, n01, n00);
  const nativePairedRate = rate(n11 + n10, nPairs);
  const mafPairedRate = rate(n11 + n01, nPairs);
  const difference =
    nativePairedRate === null || mafPairedRate === null ? null : mafPairedRate - nativePairedRate;

  const completedSlots = input.observations.length;
  const complete = completedSlots === input.expectedSlots;
  const anyUnobserved = pairs.some(
    (p) => p.native.status === "UNOBSERVED" || p.maf.status === "UNOBSERVED",
  );
  const reportStatus: AnalysisV1Report["reportStatus"] =
    complete && input.allowFinal === true && !anyUnobserved ? "FINAL" : "PROVISIONAL";

  const notes: string[] = [];
  if (reportStatus === "PROVISIONAL") {
    notes.push(
      `${completedSlots} of ${input.expectedSlots} scoring observations are present; this analysis ` +
        "is PROVISIONAL and must not inform any stopping decision (EXPERIMENT_PROTOCOL.md 18).",
    );
  }
  const reduced = cells.filter((c) => c.reducedN);
  if (reduced.length > 0) {
    notes.push(
      `${reduced.length} task-arm cell(s) have reduced N; Protocol v1 section 17.2 requires this ` +
        "reduction be disclosed rather than hidden.",
    );
  }
  const excluded = pairs.filter((p) => !p.eligible);
  if (excluded.length > 0) {
    notes.push(
      `${excluded.length} of ${pairs.length} task(s) are excluded from paired inference because ` +
        "at least one arm lacks a determinate binary cell outcome. They are reported, not imputed.",
    );
  }
  const runNative = runLevelArm(input.observations, "NATIVE");
  const runMaf = runLevelArm(input.observations, "MAF");
  if (runNative.validRuns !== runMaf.validRuns) {
    notes.push(
      `Unequal run-level valid denominators (NATIVE=${runNative.validRuns}, MAF=${runMaf.validRuns}) ` +
        "are left visible in the primary metric; they are not equalized by imputation, by counting " +
        "invalid as failure, or by dropping otherwise-valid runs.",
    );
  }

  return {
    analysisTag: ANALYSIS_TAG,
    analysisVersion: ANALYSIS_VERSION,
    reportStatus,
    stoppingDecisionUse: "NOT_FOR_STOPPING_DECISIONS",
    completedSlots,
    expectedSlots: input.expectedSlots,
    pairs,
    runLevel: { native: runNative, maf: runMaf },
    taskLevelDescriptive: {
      native: taskLevelArm(cells, "NATIVE"),
      maf: taskLevelArm(cells, "MAF"),
    },
    pairedInference: {
      eligibleTaskCount: nPairs,
      excludedTaskCount: excluded.length,
      n11,
      n10,
      n01,
      n00,
      nativeRate: nativePairedRate,
      mafRate: mafPairedRate,
      difference,
      mcnemar,
      differenceInterval,
    },
    notes,
  };
};
