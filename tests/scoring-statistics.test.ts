import { describe, expect, it } from "vitest";
import {
  aggregateTaskArmCell,
  analyzeScoringRuns,
  binomialCoefficient,
  classifyTaskPair,
  mcNemarExactTest,
  wilsonScoreInterval,
  KNOWN_STATISTICAL_AMBIGUITIES,
  type ScoringRunSummary,
} from "../evaluation/experiments/scoring/lib/statistics";

const run = (overrides: Partial<ScoringRunSummary> = {}): ScoringRunSummary => ({
  taskId: "alpha",
  arm: "NATIVE",
  replicate: 1,
  runValidity: "VALID",
  infrastructureInvalid: false,
  dvs: true,
  falseSafe: false,
  hiddenGraderPass: true,
  regressionPass: true,
  candidateIntegrityValid: true,
  costUsd: 1,
  costStatus: "KNOWN",
  elapsedMs: 1000,
  ...overrides,
});

describe("Wilson score interval (single proportion, fully specified)", () => {
  it("matches published reference values for 8/10", () => {
    const interval = wilsonScoreInterval(8, 10);
    expect(interval.lower).toBeCloseTo(0.4902, 4);
    expect(interval.upper).toBeCloseTo(0.9433, 4);
  });

  it("matches published reference values for 0/10 and clamps to [0,1]", () => {
    const interval = wilsonScoreInterval(0, 10);
    expect(interval.lower).toBe(0);
    expect(interval.upper).toBeCloseTo(0.2775, 4);
  });

  it("matches published reference values for 29/29", () => {
    const interval = wilsonScoreInterval(29, 29);
    expect(interval.lower).toBeCloseTo(0.8828, 3);
    expect(interval.upper).toBe(1);
  });

  it("is symmetric under success/failure inversion", () => {
    const a = wilsonScoreInterval(7, 20);
    const b = wilsonScoreInterval(13, 20);
    expect(a.lower).toBeCloseTo(1 - b.upper, 10);
    expect(a.upper).toBeCloseTo(1 - b.lower, 10);
  });

  it("returns the whole interval for n=0 rather than dividing by zero", () => {
    expect(wilsonScoreInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it("rejects impossible inputs", () => {
    expect(() => wilsonScoreInterval(5, 3)).toThrow(/successes <= n/u);
    expect(() => wilsonScoreInterval(-1, 3)).toThrow(/non-negative/u);
  });
});

describe("McNemar exact binomial test (fully specified by section 15.3)", () => {
  it("computes binomial coefficients exactly", () => {
    expect(binomialCoefficient(29, 14)).toBe(77558760);
    expect(binomialCoefficient(10, 5)).toBe(252);
    expect(binomialCoefficient(9, 0)).toBe(1);
  });

  it("matches a hand-computed two-sided p for 8 vs 1 discordant pairs", () => {
    // 2 * (C(9,0) + C(9,1)) / 2^9 = 2 * 10 / 512
    expect(mcNemarExactTest(8, 1).pValue).toBeCloseTo(20 / 512, 12);
  });

  it("matches a hand-computed two-sided p for 3 vs 0 discordant pairs", () => {
    expect(mcNemarExactTest(3, 0).pValue).toBeCloseTo(0.25, 12);
  });

  it("caps a perfectly balanced split at p=1", () => {
    expect(mcNemarExactTest(5, 5).pValue).toBe(1);
  });

  it("is symmetric in its two discordant counts", () => {
    expect(mcNemarExactTest(7, 2).pValue).toBeCloseTo(mcNemarExactTest(2, 7).pValue, 12);
  });

  it("reports p=1 with no discordant pairs, and says that is not evidence of equivalence", () => {
    const result = mcNemarExactTest(0, 0);
    expect(result.pValue).toBe(1);
    expect(result.discordantPairs).toBe(0);
    expect(result.detail).toMatch(/not evidence of equivalence/u);
  });

  it("ignores concordant pairs entirely, as the paired design requires", () => {
    // Only the discordant counts are inputs; concordant pairs cannot change the p-value.
    expect(mcNemarExactTest(6, 1).pValue).toBeCloseTo(mcNemarExactTest(6, 1).pValue, 12);
  });
});

describe("task-level majority aggregation (section 15.1)", () => {
  it("resolves 3-of-3 valid repetitions by strict majority", () => {
    const twoOfThree = aggregateTaskArmCell(
      "alpha",
      "NATIVE",
      [run({ dvs: true }), run({ replicate: 2, dvs: true }), run({ replicate: 3, dvs: false })],
      3,
    );
    expect(twoOfThree.taskLevelDvs).toEqual({ status: "DETERMINED", value: true });

    const oneOfThree = aggregateTaskArmCell(
      "alpha",
      "NATIVE",
      [run({ dvs: true }), run({ replicate: 2, dvs: false }), run({ replicate: 3, dvs: false })],
      3,
    );
    expect(oneOfThree.taskLevelDvs).toEqual({ status: "DETERMINED", value: false });
  });

  it("marks a cell whose repetitions are ALL invalid as an invalid cell", () => {
    const cell = aggregateTaskArmCell(
      "alpha",
      "NATIVE",
      [
        run({ runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
        run({ replicate: 2, runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
        run({ replicate: 3, runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
      ],
      3,
    );
    expect(cell.cellInvalid).toBe(true);
    expect(cell.validRuns).toBe(0);
  });

  it("REFUSES to guess when only some repetitions are invalid (the documented gap)", () => {
    const cell = aggregateTaskArmCell(
      "alpha",
      "NATIVE",
      [
        run({ dvs: true }),
        run({ replicate: 2, runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
        run({ replicate: 3, runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
      ],
      3,
    );
    expect(cell.taskLevelDvs.status).toBe("UNDERSPECIFIED");
    if (cell.taskLevelDvs.status === "UNDERSPECIFIED") {
      expect(cell.taskLevelDvs.ambiguity.id).toBe("MAJORITY_OF_3_WITH_INVALID_REPETITIONS");
    }
    expect(cell.reducedN).toBe(true);
  });

  it("refuses the 1-1 split at reduced N, which has no majority and no tie-break rule", () => {
    const cell = aggregateTaskArmCell(
      "alpha",
      "NATIVE",
      [
        run({ dvs: true }),
        run({ replicate: 2, dvs: false }),
        run({ replicate: 3, runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
      ],
      3,
    );
    expect(cell.taskLevelDvs.status).toBe("UNDERSPECIFIED");
  });

  it("never treats an unknown cost as zero", () => {
    const cell = aggregateTaskArmCell(
      "alpha",
      "NATIVE",
      [
        run({ costUsd: 2, costStatus: "KNOWN" }),
        run({ replicate: 2, costUsd: null, costStatus: "UNKNOWN" }),
        run({ replicate: 3, costUsd: 4, costStatus: "KNOWN" }),
      ],
      3,
    );
    // Mean is over the measured repetitions only, and the status says it is incomplete.
    expect(cell.meanCostUsd).toBe(3);
    expect(cell.costStatus).toBe("PARTIAL");
  });
});

describe("paired task-level classification (section 15.2)", () => {
  const cell = (arm: "NATIVE" | "MAF", dvs: boolean) =>
    aggregateTaskArmCell(
      "alpha",
      arm,
      [run({ arm, dvs }), run({ arm, replicate: 2, dvs }), run({ arm, replicate: 3, dvs })],
      3,
    );
  const invalidCell = (arm: "NATIVE" | "MAF") =>
    aggregateTaskArmCell(
      "alpha",
      arm,
      [1, 2, 3].map((replicate) =>
        run({ arm, replicate, runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
      ),
      3,
    );

  it("classifies the four concordant/discordant outcomes", () => {
    expect(classifyTaskPair(cell("NATIVE", true), cell("MAF", true))).toBe("BOTH_PASS");
    expect(classifyTaskPair(cell("NATIVE", false), cell("MAF", true))).toBe("MAF_ONLY_PASS");
    expect(classifyTaskPair(cell("NATIVE", true), cell("MAF", false))).toBe("NATIVE_ONLY_PASS");
    expect(classifyTaskPair(cell("NATIVE", false), cell("MAF", false))).toBe("BOTH_FAIL");
  });

  it("keeps INVALID_BOTH distinct from a single-arm invalidation", () => {
    expect(classifyTaskPair(invalidCell("NATIVE"), invalidCell("MAF"))).toBe("INVALID_BOTH");
    expect(classifyTaskPair(invalidCell("NATIVE"), cell("MAF", true))).toBe("INVALID_NATIVE");
    expect(classifyTaskPair(cell("NATIVE", true), invalidCell("MAF"))).toBe("INVALID_MAF");
  });
});

describe("full analysis over a complete synthetic campaign", () => {
  const taskIds = Array.from({ length: 6 }, (_, i) => `task-${i}`);

  const completeRuns = (spec: Array<{ native: boolean; maf: boolean }>): ScoringRunSummary[] => {
    const runs: ScoringRunSummary[] = [];
    spec.forEach((outcome, index) => {
      for (let replicate = 1; replicate <= 3; replicate += 1) {
        runs.push(run({ taskId: `task-${index}`, arm: "NATIVE", replicate, dvs: outcome.native }));
        runs.push(run({ taskId: `task-${index}`, arm: "MAF", replicate, dvs: outcome.maf }));
      }
    });
    return runs;
  };

  it("computes per-arm rates, intervals and the exact paired test", () => {
    // 3 BOTH_PASS, 2 MAF_ONLY_PASS, 1 NATIVE_ONLY_PASS.
    const analysis = analyzeScoringRuns({
      runs: completeRuns([
        { native: true, maf: true },
        { native: true, maf: true },
        { native: true, maf: true },
        { native: false, maf: true },
        { native: false, maf: true },
        { native: true, maf: false },
      ]),
      taskIds,
      runsPerTask: 3,
      expectedSlots: 36,
    });

    expect(analysis.native.determinedCells).toBe(6);
    expect(analysis.maf.determinedCells).toBe(6);
    expect(analysis.native.dvsCells).toBe(4);
    expect(analysis.maf.dvsCells).toBe(5);
    expect(analysis.native.dvsRate).toBeCloseTo(4 / 6, 10);
    expect(analysis.maf.dvsRate).toBeCloseTo(5 / 6, 10);
    expect(analysis.dvsRateDifference).toEqual({
      status: "DETERMINED",
      value: 5 / 6 - 4 / 6,
    });

    expect(analysis.mcNemar.status).toBe("DETERMINED");
    if (analysis.mcNemar.status === "DETERMINED") {
      expect(analysis.mcNemar.value.mafOnlyPass).toBe(2);
      expect(analysis.mcNemar.value.nativeOnlyPass).toBe(1);
      // 2 * (C(3,0) + C(3,1)) / 2^3 = 1
      expect(analysis.mcNemar.value.pValue).toBe(1);
    }
  });

  it("labels an incomplete campaign PROVISIONAL and NOT_FOR_STOPPING_DECISIONS", () => {
    const analysis = analyzeScoringRuns({
      runs: completeRuns([{ native: true, maf: true }]),
      taskIds,
      runsPerTask: 3,
      expectedSlots: 36,
    });
    expect(analysis.reportStatus).toBe("PROVISIONAL");
    expect(analysis.stoppingDecisionUse).toBe("NOT_FOR_STOPPING_DECISIONS");
    expect(analysis.notes.join(" ")).toMatch(/PROVISIONAL/u);
  });

  it("never marks a report FINAL unless it is complete AND explicitly permitted", () => {
    const runs = completeRuns(taskIds.map(() => ({ native: true, maf: true })));
    expect(
      analyzeScoringRuns({ runs, taskIds, runsPerTask: 3, expectedSlots: 36 }).reportStatus,
    ).toBe("PROVISIONAL");
    expect(
      analyzeScoringRuns({ runs, taskIds, runsPerTask: 3, expectedSlots: 36, allowFinal: true })
        .reportStatus,
    ).toBe("FINAL");
    expect(
      analyzeScoringRuns({ runs, taskIds, runsPerTask: 3, expectedSlots: 999, allowFinal: true })
        .reportStatus,
    ).toBe("PROVISIONAL");
  });

  it("always reports the difference CI as underspecified, never as a number", () => {
    const analysis = analyzeScoringRuns({
      runs: completeRuns(taskIds.map(() => ({ native: true, maf: true }))),
      taskIds,
      runsPerTask: 3,
      expectedSlots: 36,
      allowFinal: true,
    });
    expect(analysis.dvsRateDifferenceInterval.status).toBe("UNDERSPECIFIED");
    expect(analysis.dvsRateDifferenceInterval.ambiguity.id).toBe(
      "WILSON_INTERVAL_ON_A_DIFFERENCE_OF_PAIRED_PROPORTIONS",
    );
    expect(analysis.underspecified.map((a) => a.id)).toContain(
      "WILSON_INTERVAL_ON_A_DIFFERENCE_OF_PAIRED_PROPORTIONS",
    );
  });

  it("does not fold an invalid run into the valid-run denominator as a failure", () => {
    // One task-arm cell is entirely invalid: it must leave the denominator, not count as a loss.
    const runs = completeRuns(taskIds.map(() => ({ native: true, maf: true })));
    const withInvalid = runs.map((r) =>
      r.taskId === "task-0" && r.arm === "NATIVE"
        ? { ...r, runValidity: "INVALID" as const, infrastructureInvalid: true, dvs: false }
        : r,
    );
    const analysis = analyzeScoringRuns({
      runs: withInvalid,
      taskIds,
      runsPerTask: 3,
      expectedSlots: 36,
    });
    expect(analysis.native.determinedCells).toBe(5);
    expect(analysis.native.invalidCells).toBe(1);
    expect(analysis.native.dvsRate).toBe(1); // 5 of 5 determined, not 5 of 6
  });

  it("refuses the paired test when any pair is undetermined", () => {
    const runs = completeRuns(taskIds.map(() => ({ native: true, maf: true })));
    const partiallyInvalid = runs.map((r) =>
      r.taskId === "task-0" && r.arm === "NATIVE" && r.replicate === 1
        ? { ...r, runValidity: "INVALID" as const, infrastructureInvalid: true, dvs: false }
        : r,
    );
    const analysis = analyzeScoringRuns({
      runs: partiallyInvalid,
      taskIds,
      runsPerTask: 3,
      expectedSlots: 36,
    });
    expect(analysis.mcNemar.status).toBe("UNDERSPECIFIED");
  });
});

describe("documented statistical ambiguities", () => {
  it("names all three gaps with frozen text, candidates and consequences", () => {
    expect(KNOWN_STATISTICAL_AMBIGUITIES.map((a) => a.id).sort()).toEqual([
      "DIFFERENCE_BETWEEN_RATES_WITH_UNEQUAL_DENOMINATORS",
      "MAJORITY_OF_3_WITH_INVALID_REPETITIONS",
      "WILSON_INTERVAL_ON_A_DIFFERENCE_OF_PAIRED_PROPORTIONS",
    ]);
    for (const ambiguity of KNOWN_STATISTICAL_AMBIGUITIES) {
      expect(ambiguity.frozenTextSays.length).toBeGreaterThan(40);
      expect(ambiguity.candidateInterpretations.length).toBeGreaterThanOrEqual(2);
      expect(ambiguity.consequence.length).toBeGreaterThan(40);
    }
  });
});
