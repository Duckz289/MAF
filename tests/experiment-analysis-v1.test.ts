import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_TAG,
  ANALYSIS_VERSION,
  CONFIDENCE_LEVEL,
  PLANNED_REPETITIONS,
  PROTOCOL_V2_SHA,
  PROTOCOL_V2_TAG,
  SUITE_SHA,
  SUITE_TAG,
  WILSON_Z_95,
  aggregateTaskArmCell,
  analyzeExperimentV1,
  classifyTaskPair,
  mcNemarExactTest,
  newcombePairedDifferenceInterval,
  wilsonScoreInterval,
  wilsonScoreIntervalQuadratic,
  type Observation,
} from "../evaluation/experiments/analysis/analysis-v1";
import { mcNemarExactTest as runnerMcNemar } from "../evaluation/experiments/scoring/lib/statistics";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const obs = (overrides: Partial<Observation> = {}): Observation => ({
  taskId: "alpha",
  arm: "NATIVE",
  replicate: 1,
  runValidity: "VALID",
  dvs: true,
  ...overrides,
});

const three = (arm: "NATIVE" | "MAF", dvs: [boolean, boolean, boolean]): Observation[] =>
  dvs.map((value, index) => obs({ arm, replicate: index + 1, dvs: value }));

const invalid = (arm: "NATIVE" | "MAF", replicate: number): Observation =>
  obs({ arm, replicate, runValidity: "INVALID", dvs: false });

describe("analysis v1 identity", () => {
  it("pins the frozen suite and protocol v2 identities", () => {
    expect(ANALYSIS_TAG).toBe("maf-experiment-analysis-v1");
    expect(ANALYSIS_VERSION).toBe("1.0.0");
    expect(SUITE_TAG).toBe("maf-suite-freeze-v1");
    expect(SUITE_SHA).toBe("92f13ae67802dd0049ca001f70839a9451120900");
    expect(PROTOCOL_V2_TAG).toBe("maf-experiment-protocol-v2");
    expect(PROTOCOL_V2_SHA).toBe("b086b21e1e66f4a3c039d5c60079d9311eb82e15");
    expect(CONFIDENCE_LEVEL).toBe(0.95);
    expect(PLANNED_REPETITIONS).toBe(3);
  });
});

describe("cell aggregation (majority-of-3 under reduced N)", () => {
  it("resolves 3/3 valid by ordinary majority", () => {
    const pass = aggregateTaskArmCell("alpha", "NATIVE", three("NATIVE", [true, true, false]));
    expect(pass.status).toBe("DETERMINATE");
    expect(pass.binaryOutcome).toBe(true);
    expect(pass.reducedN).toBe(false);

    const fail = aggregateTaskArmCell("alpha", "NATIVE", three("NATIVE", [true, false, false]));
    expect(fail.status).toBe("DETERMINATE");
    expect(fail.binaryOutcome).toBe(false);
  });

  it("resolves 2/3 valid when both remaining observations agree", () => {
    const twoPass = aggregateTaskArmCell("alpha", "NATIVE", [
      obs({ dvs: true }),
      obs({ replicate: 2, dvs: true }),
      invalid("NATIVE", 3),
    ]);
    expect(twoPass.status).toBe("DETERMINATE");
    expect(twoPass.binaryOutcome).toBe(true);
    expect(twoPass.validObservations).toBe(2);
    expect(twoPass.reducedN).toBe(true);

    const twoFail = aggregateTaskArmCell("alpha", "NATIVE", [
      obs({ dvs: false }),
      obs({ replicate: 2, dvs: false }),
      invalid("NATIVE", 3),
    ]);
    expect(twoFail.status).toBe("DETERMINATE");
    expect(twoFail.binaryOutcome).toBe(false);
  });

  it("leaves a 2/3 1-PASS/1-FAIL split UNRESOLVED with no imputation", () => {
    const cell = aggregateTaskArmCell("alpha", "NATIVE", [
      obs({ dvs: true }),
      obs({ replicate: 2, dvs: false }),
      invalid("NATIVE", 3),
    ]);
    expect(cell.status).toBe("UNRESOLVED");
    expect(cell.binaryOutcome).toBeNull();
    expect(cell.unresolvedReason).toMatch(/split/u);
  });

  it("leaves 1/3 valid UNRESOLVED", () => {
    const cell = aggregateTaskArmCell("alpha", "NATIVE", [
      obs({ dvs: true }),
      invalid("NATIVE", 2),
      invalid("NATIVE", 3),
    ]);
    expect(cell.status).toBe("UNRESOLVED");
    expect(cell.binaryOutcome).toBeNull();
    expect(cell.dvsSuccessesAmongValid).toBe(1);
  });

  it("marks 0/3 valid as INVALID_CELL and does not convert invalid to DVS=false", () => {
    const cell = aggregateTaskArmCell("alpha", "NATIVE", [
      invalid("NATIVE", 1),
      { ...invalid("NATIVE", 2), dvs: true },
      invalid("NATIVE", 3),
    ]);
    expect(cell.status).toBe("INVALID_CELL");
    expect(cell.binaryOutcome).toBeNull();
    expect(cell.dvsSuccessesAmongValid).toBe(0);
    expect(cell.validObservations).toBe(0);
  });

  it("marks a cell with no observations as UNOBSERVED, not invalid", () => {
    const cell = aggregateTaskArmCell("alpha", "NATIVE", []);
    expect(cell.status).toBe("UNOBSERVED");
    expect(cell.reducedN).toBe(false);
  });
});

describe("paired task eligibility", () => {
  const determinate = (arm: "NATIVE" | "MAF", value: boolean) =>
    aggregateTaskArmCell(
      arm === "NATIVE" ? "alpha" : "alpha",
      arm,
      three(arm, [value, value, value]),
    );

  it("includes a task only when both arms are determinate", () => {
    const pair = classifyTaskPair(determinate("NATIVE", true), determinate("MAF", false));
    expect(pair.eligible).toBe(true);
    expect(pair.classification).toBe("NATIVE_ONLY_PASS");
  });

  it("classifies all four contingency cells", () => {
    expect(
      classifyTaskPair(determinate("NATIVE", true), determinate("MAF", true)).classification,
    ).toBe("BOTH_PASS");
    expect(
      classifyTaskPair(determinate("NATIVE", false), determinate("MAF", true)).classification,
    ).toBe("MAF_ONLY_PASS");
    expect(
      classifyTaskPair(determinate("NATIVE", true), determinate("MAF", false)).classification,
    ).toBe("NATIVE_ONLY_PASS");
    expect(
      classifyTaskPair(determinate("NATIVE", false), determinate("MAF", false)).classification,
    ).toBe("BOTH_FAIL");
  });

  it("excludes unresolved or invalid cells on either arm without imputing", () => {
    const unresolved = aggregateTaskArmCell("alpha", "NATIVE", [
      obs({ dvs: true }),
      invalid("NATIVE", 2),
      invalid("NATIVE", 3),
    ]);
    const validMaf = determinate("MAF", true);
    const excluded = classifyTaskPair(unresolved, validMaf);
    expect(excluded.eligible).toBe(false);
    expect(excluded.classification).toBe("EXCLUDED");
    expect(excluded.exclusionReason).toBe("UNRESOLVED_NATIVE");
  });
});

describe("exact McNemar", () => {
  it("matches the runner's already-specified exact binomial on discordant pairs", () => {
    const ours = mcNemarExactTest(12, 1, 8, 8);
    const theirs = runnerMcNemar(8, 1);
    expect(ours.pValue).toBeCloseTo(theirs.pValue, 12);
    expect(ours.discordantPairs).toBe(9);
    expect(ours.n11).toBe(12);
    expect(ours.n10).toBe(1);
    expect(ours.n01).toBe(8);
    expect(ours.n00).toBe(8);
  });

  it("computes 8 vs 1 as 2*(C(9,0)+C(9,1))/2^9", () => {
    expect(mcNemarExactTest(0, 1, 8, 0).pValue).toBeCloseTo(20 / 512, 12);
  });

  it("computes a one-sided 3 vs 0 imbalance as 0.25", () => {
    expect(mcNemarExactTest(20, 0, 3, 6).pValue).toBeCloseTo(0.25, 12);
  });

  it("reports p=1 at zero discordance and says that is not equivalence", () => {
    const result = mcNemarExactTest(15, 0, 0, 14);
    expect(result.pValue).toBe(1);
    expect(result.zeroDiscordance).toBe(true);
    expect(result.detail).toMatch(/not evidence of equivalence/u);
  });

  it("does not switch to an asymptotic method at small discordant counts", () => {
    expect(mcNemarExactTest(10, 0, 1, 10).method).toBe("EXACT_BINOMIAL_TWO_SIDED_P_EQUALS_HALF");
    expect(mcNemarExactTest(10, 0, 1, 10).pValue).toBe(1);
  });
});

describe("Newcombe 1998 method 10 paired difference CI", () => {
  it("matches published Table III at z=1.96 to four decimal places", () => {
    const published: Array<[number, number, number, number, number, number]> = [
      [36, 2, 12, 0, 0.0569, 0.3404],
      [20, 2, 12, 16, 0.0562, 0.3292],
      [18, 2, 12, 18, 0.0562, 0.329],
      [36, 0, 14, 0, 0.1528, 0.4167],
      [35, 0, 14, 1, 0.1461, 0.4175],
      [18, 0, 14, 18, 0.1441, 0.3963],
      [2, 1, 97, 0, 0.8721, 0.9854],
      [1, 1, 97, 1, 0.8736, 0.985],
      [0, 1, 29, 0, 0.6666, 0.9882],
      [2, 0, 98, 0, 0.9178, 0.9945],
      [1, 0, 98, 1, 0.9171, 0.9916],
      [0, 0, 30, 0, 0.8395, 1],
      [54, 0, 0, 0, -0.0664, 0.0664],
      [53, 0, 0, 1, -0.0729, 0.0729],
      [30, 0, 0, 24, -0.0358, 0.0358],
      [29, 0, 0, 25, -0.0354, 0.0354],
      [28, 0, 0, 26, -0.0352, 0.0352],
      [27, 0, 0, 27, -0.0351, 0.0351],
    ];
    for (const [n11, n10, n01, n00, lo, hi] of published) {
      const interval = newcombePairedDifferenceInterval(n11, n10, n01, n00, 1.96);
      expect(interval.status).toBe("DETERMINED");
      if (interval.status === "DETERMINED") {
        // Table III prints 4 d.p.; one unit in the last published place is 1e-4.
        expect(Math.abs(interval.lower - lo)).toBeLessThan(1e-4);
        expect(Math.abs(interval.upper - hi)).toBeLessThan(1e-4);
      }
    }
  });

  it("agrees with an independent quadratic Wilson construction to 1e-12", () => {
    const cases: Array<[number, number, number, number]> = [
      [3, 1, 2, 0],
      [29, 0, 0, 0],
      [15, 0, 0, 14],
      [10, 0, 8, 11],
      [20, 0, 3, 6],
      [12, 1, 8, 8],
      [0, 0, 0, 29],
      [0, 0, 29, 0],
      [4, 1, 1, 4],
      [0, 0, 5, 0],
    ];
    for (const [n11, n10, n01, n00] of cases) {
      const n = n11 + n10 + n01 + n00;
      const closedMaf = wilsonScoreInterval(n11 + n01, n);
      const quadMaf = wilsonScoreIntervalQuadratic(n11 + n01, n);
      expect(closedMaf.lower).toBeCloseTo(quadMaf.lower, 12);
      expect(closedMaf.upper).toBeCloseTo(quadMaf.upper, 12);
      const closedNative = wilsonScoreInterval(n11 + n10, n);
      const quadNative = wilsonScoreIntervalQuadratic(n11 + n10, n);
      expect(closedNative.lower).toBeCloseTo(quadNative.lower, 12);
      expect(closedNative.upper).toBeCloseTo(quadNative.upper, 12);
    }
  });

  it("matches independent Python reference values at the frozen z", () => {
    const refs: Array<[number, number, number, number, number, number, number]> = [
      [3, 1, 2, 0, 0.1666666667, -0.3556484467, 0.5965431491],
      [29, 0, 0, 0, 0, -0.1169697985, 0.1169697985],
      [15, 0, 0, 14, 0, -0.0636373316, 0.0636373316],
      [10, 0, 8, 11, 0.275862069, 0.0932902132, 0.4260410479],
      [20, 0, 3, 6, 0.1034482759, -0.0294313796, 0.2392853737],
      [12, 1, 8, 8, 0.2413793103, 0.0418619038, 0.41083819],
      [0, 0, 0, 29, 0, -0.1169697985, 0.1169697985],
      [0, 0, 29, 0, 1, 0.8345797246, 1],
      [4, 1, 1, 4, 0, -0.2885478123, 0.2885478123],
      [0, 0, 5, 0, 1, 0.3855490057, 1],
    ];
    for (const [n11, n10, n01, n00, estimate, lo, hi] of refs) {
      const interval = newcombePairedDifferenceInterval(n11, n10, n01, n00, WILSON_Z_95);
      expect(interval.status).toBe("DETERMINED");
      if (interval.status === "DETERMINED") {
        expect(interval.estimate).toBeCloseTo(estimate, 9);
        expect(interval.lower).toBeCloseTo(lo, 9);
        expect(interval.upper).toBeCloseTo(hi, 9);
      }
    }
  });

  it("is inapplicable when there are no eligible pairs", () => {
    const interval = newcombePairedDifferenceInterval(0, 0, 0, 0);
    expect(interval.status).toBe("INAPPLICABLE");
  });

  it("stays inside [-1, 1] at boundary proportions 0 and 1", () => {
    const allPass = newcombePairedDifferenceInterval(29, 0, 0, 0);
    const allFail = newcombePairedDifferenceInterval(0, 0, 0, 29);
    const allMaf = newcombePairedDifferenceInterval(0, 0, 29, 0);
    for (const interval of [allPass, allFail, allMaf]) {
      expect(interval.status).toBe("DETERMINED");
      if (interval.status === "DETERMINED") {
        expect(interval.lower).toBeGreaterThanOrEqual(-1);
        expect(interval.upper).toBeLessThanOrEqual(1);
      }
    }
  });

  it("does not collapse to a zero-width interval at zero discordance", () => {
    const interval = newcombePairedDifferenceInterval(15, 0, 0, 14);
    expect(interval.status).toBe("DETERMINED");
    if (interval.status === "DETERMINED") {
      expect(interval.estimate).toBe(0);
      expect(interval.upper - interval.lower).toBeGreaterThan(0.05);
    }
  });
});

describe("full analysis v1 over synthetic campaigns", () => {
  const taskIds = Array.from({ length: 6 }, (_, i) => `task-${i}`);

  const completeRuns = (spec: Array<{ native: boolean; maf: boolean }>): Observation[] => {
    const runs: Observation[] = [];
    spec.forEach((outcome, index) => {
      for (let replicate = 1; replicate <= 3; replicate += 1) {
        runs.push(obs({ taskId: `task-${index}`, arm: "NATIVE", replicate, dvs: outcome.native }));
        runs.push(obs({ taskId: `task-${index}`, arm: "MAF", replicate, dvs: outcome.maf }));
      }
    });
    return runs;
  };

  it("keeps the primary metric as run-level DVS among valid runs", () => {
    const analysis = analyzeExperimentV1({
      observations: completeRuns([
        { native: true, maf: true },
        { native: true, maf: true },
        { native: true, maf: true },
        { native: false, maf: true },
        { native: false, maf: true },
        { native: true, maf: false },
      ]),
      taskIds,
      expectedSlots: 36,
    });
    expect(analysis.runLevel.native.dvsCount).toBe(12);
    expect(analysis.runLevel.native.validRuns).toBe(18);
    expect(analysis.runLevel.native.rate).toBeCloseTo(12 / 18, 10);
    expect(analysis.runLevel.maf.dvsCount).toBe(15);
    expect(analysis.runLevel.maf.validRuns).toBe(18);
    expect(analysis.pairedInference.n11).toBe(3);
    expect(analysis.pairedInference.n01).toBe(2);
    expect(analysis.pairedInference.n10).toBe(1);
    expect(analysis.pairedInference.n00).toBe(0);
    expect(analysis.pairedInference.difference).toBeCloseTo(1 / 6, 10);
    expect(analysis.pairedInference.differenceInterval.status).toBe("DETERMINED");
  });

  it("excludes a 1/3-valid cell from paired inference while leaving the valid run in the primary metric", () => {
    const runs = completeRuns(taskIds.map(() => ({ native: true, maf: true })));
    const withPartial = runs.map((r) =>
      r.taskId === "task-0" && r.arm === "NATIVE" && r.replicate !== 1
        ? { ...r, runValidity: "INVALID" as const, dvs: false }
        : r,
    );
    const analysis = analyzeExperimentV1({
      observations: withPartial,
      taskIds,
      expectedSlots: 36,
    });
    expect(analysis.runLevel.native.validRuns).toBe(16);
    expect(analysis.runLevel.native.invalidRuns).toBe(2);
    expect(analysis.runLevel.native.dvsCount).toBe(16);
    expect(analysis.pairedInference.eligibleTaskCount).toBe(5);
    expect(analysis.pairedInference.excludedTaskCount).toBe(1);
    const excluded = analysis.pairs.find((p) => p.taskId === "task-0");
    expect(excluded?.eligible).toBe(false);
    expect(excluded?.exclusionReason).toBe("UNRESOLVED_NATIVE");
  });

  it("does not equalize unequal run-level denominators and does not count invalid as failure", () => {
    const runs = completeRuns(taskIds.map(() => ({ native: true, maf: true })));
    const withInvalid = runs.map((r) =>
      r.taskId === "task-0" && r.arm === "NATIVE"
        ? { ...r, runValidity: "INVALID" as const, dvs: false }
        : r,
    );
    const analysis = analyzeExperimentV1({
      observations: withInvalid,
      taskIds,
      expectedSlots: 36,
    });
    expect(analysis.runLevel.native.validRuns).toBe(15);
    expect(analysis.runLevel.maf.validRuns).toBe(18);
    expect(analysis.runLevel.native.rate).toBe(1);
    expect(analysis.taskLevelDescriptive.native.invalidCells).toBe(1);
    expect(analysis.taskLevelDescriptive.native.determinateCells).toBe(5);
    expect(analysis.pairedInference.eligibleTaskCount).toBe(5);
    expect(analysis.notes.join(" ")).toMatch(/Unequal run-level valid denominators/u);
  });

  it("labels incomplete campaigns PROVISIONAL and not for stopping", () => {
    const analysis = analyzeExperimentV1({
      observations: completeRuns([{ native: true, maf: true }]),
      taskIds,
      expectedSlots: 36,
    });
    expect(analysis.reportStatus).toBe("PROVISIONAL");
    expect(analysis.stoppingDecisionUse).toBe("NOT_FOR_STOPPING_DECISIONS");
  });

  it("rejects duplicate slot observations and unknown task ids", () => {
    expect(() =>
      analyzeExperimentV1({
        observations: [obs(), obs()],
        taskIds: ["alpha"],
        expectedSlots: 6,
      }),
    ).toThrow(/duplicate observation/u);
    expect(() =>
      analyzeExperimentV1({
        observations: [obs({ taskId: "preflight-task" })],
        taskIds: ["alpha"],
        expectedSlots: 6,
      }),
    ).toThrow(/not in the analysis task list/u);
  });
});

describe("machine-readable analysis spec", () => {
  it("declares the frozen identities and the three resolved decisions", async () => {
    const raw = JSON.parse(
      await readFile(
        path.join(repoRoot, "evaluation/experiments/experiment-analysis-v1.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(raw.analysisVersion).toBe("1.0.0");
    expect(raw.status).toBe("FROZEN_PRE_SCORING");
    expect(raw.suiteTag).toBe(SUITE_TAG);
    expect(raw.suiteSha).toBe(SUITE_SHA);
    expect(raw.protocolTag).toBe(PROTOCOL_V2_TAG);
    expect(raw.protocolSha).toBe(PROTOCOL_V2_SHA);
    expect(raw.createdBeforeScoring).toBe(true);
    expect(raw.noImputation).toBe(true);
    expect(raw.primaryMetric).toBe("DVS_RATE_AMONG_VALID_RUNS");
    expect(raw.mcnemarMethod).toBe("EXACT_BINOMIAL_TWO_SIDED_P_EQUALS_HALF");
    expect(raw.pairedDifferenceCiMethod).toBe("NEWCOMBE_1998_STAT_MED_17_2635_METHOD_10");
    expect(raw.confidenceLevel).toBe(0.95);
  });
});
