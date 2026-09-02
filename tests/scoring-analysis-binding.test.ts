import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_IDENTITY,
  authoritativeObservation,
  runFrozenAnalysis,
  toAnalysisObservations,
} from "../evaluation/experiments/scoring/lib/analysis-binding";
import {
  ANALYSIS_SHA,
  ANALYSIS_TAG,
  ANALYSIS_VERSION,
} from "../evaluation/experiments/scoring/lib/frozen-refs";
import { loadFrozenTaskIds } from "../evaluation/experiments/scoring/lib/schedule";
import type {
  ObservationRecord,
  SlotState,
} from "../evaluation/experiments/scoring/lib/state-store";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const observation = (overrides: Partial<ObservationRecord> = {}): ObservationRecord => ({
  slotId: "alpha__NATIVE__r1",
  slotDigest: "d".repeat(64),
  generation: 0,
  observationIndex: 1,
  taskId: "alpha",
  arm: "NATIVE",
  replicate: 1,
  randomizationPosition: 0,
  sequencePosition: 0,
  recordedAt: "2026-09-02T00:00:00.000Z",
  infrastructureInvalid: false,
  dvs: true,
  runValidity: "VALID",
  costUsd: 1,
  costStatus: "KNOWN",
  provenance: {},
  ...overrides,
});

const slotState = (observations: ObservationRecord[], slotId = "alpha__NATIVE__r1"): SlotState => ({
  slotId,
  status: "COMPLETE",
  generation: observations.length,
  observations,
  adjudications: [],
  rerunAuthorizations: [],
  danglingIntents: [],
  reservation: null,
  corruption: [],
  detail: "",
});

/** Builds a complete campaign of `tasks` tasks x 2 arms x 3 replicates. */
const campaign = (
  spec: Array<{ native: boolean[]; maf: boolean[]; nativeValid?: boolean[]; mafValid?: boolean[] }>,
): SlotState[] => {
  const states: SlotState[] = [];
  spec.forEach((task, index) => {
    const taskId = `task-${index}`;
    for (const arm of ["NATIVE", "MAF"] as const) {
      const dvsList = arm === "NATIVE" ? task.native : task.maf;
      const validList =
        (arm === "NATIVE" ? task.nativeValid : task.mafValid) ?? dvsList.map(() => true);
      dvsList.forEach((dvs, i) => {
        const replicate = i + 1;
        const valid = validList[i] ?? true;
        states.push(
          slotState(
            [
              observation({
                taskId,
                arm,
                replicate,
                dvs,
                runValidity: valid ? "VALID" : "INVALID",
                infrastructureInvalid: !valid,
              }),
            ],
            `${taskId}__${arm}__r${replicate}`,
          ),
        );
      });
    }
  });
  return states;
};

describe("analysis identity is bound to the frozen tag", () => {
  it("names the frozen analysis specification exactly", () => {
    expect(ANALYSIS_IDENTITY.analysisTag).toBe("maf-experiment-analysis-v1");
    expect(ANALYSIS_IDENTITY.analysisSha).toBe("de02da424e8d639213cf03aadfd9566ab3313adb");
    expect(ANALYSIS_IDENTITY.analysisVersion).toBe("1.0.0");
    expect(ANALYSIS_TAG).toBe(ANALYSIS_IDENTITY.analysisTag);
    expect(ANALYSIS_SHA).toBe(ANALYSIS_IDENTITY.analysisSha);
    expect(ANALYSIS_VERSION).toBe(ANALYSIS_IDENTITY.analysisVersion);
  });

  it("stamps the analysis identity onto every report", () => {
    const report = runFrozenAnalysis({
      states: [],
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(report.analysisTag).toBe(ANALYSIS_TAG);
    expect(report.analysisSha).toBe(ANALYSIS_SHA);
    expect(report.analysisVersion).toBe(ANALYSIS_VERSION);
  });
});

describe("observation selection", () => {
  it("analyses the LATEST observation, since a rerun replaces rather than adds to N", () => {
    const state = slotState([
      observation({
        observationIndex: 1,
        dvs: false,
        runValidity: "INVALID",
        infrastructureInvalid: true,
      }),
      observation({ observationIndex: 2, dvs: true }),
    ]);
    expect(authoritativeObservation(state)?.observationIndex).toBe(2);

    const { observations } = toAnalysisObservations([state], ["alpha"]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.dvs).toBe(true);
    // The superseded original is still on the state object; it is preserved, just not analysed.
    expect(state.observations).toHaveLength(2);
  });

  it("returns null for a slot with no observations", () => {
    expect(authoritativeObservation(slotState([]))).toBeNull();
  });

  it("passes an invalid run through AS invalid rather than converting it to dvs=false", () => {
    const { observations } = toAnalysisObservations(
      [
        slotState([
          observation({ runValidity: "INVALID", infrastructureInvalid: true, dvs: false }),
        ]),
      ],
      ["alpha"],
    );
    expect(observations[0]?.runValidity).toBe("INVALID");
  });
});

describe("NON_SCORING and out-of-suite exclusion happens before analysis", () => {
  it("excludes the preflight fixture and records why", () => {
    const { observations, excluded } = toAnalysisObservations(
      [slotState([observation({ taskId: "preflight-task" })])],
      ["alpha"],
    );
    expect(observations).toHaveLength(0);
    expect(excluded[0]?.reason).toMatch(/NOT_PART_OF_EXPERIMENT/u);
  });

  it("excludes a task outside the frozen suite and records why", () => {
    const { observations, excluded } = toAnalysisObservations(
      [slotState([observation({ taskId: "invented-later" })])],
      ["alpha"],
    );
    expect(observations).toHaveLength(0);
    expect(excluded[0]?.reason).toMatch(/not a member of the frozen 29-task suite/u);
  });

  it("a preflight observation cannot shift any denominator", () => {
    const clean = campaign([{ native: [true, true, true], maf: [true, true, true] }]);
    const polluted = [
      ...clean,
      slotState([observation({ taskId: "preflight-task", dvs: false })], "preflight__NATIVE__r1"),
    ];
    const a = runFrozenAnalysis({
      states: clean,
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    const b = runFrozenAnalysis({
      states: polluted,
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(b.runLevel.native.validRuns).toBe(a.runLevel.native.validRuns);
    expect(b.runLevel.native.rate).toBe(a.runLevel.native.rate);
    expect(b.excludedObservations).toHaveLength(1);
  });

  it("no frozen suite task collides with a non-scoring fixture id", async () => {
    const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
    expect(frozenTaskIds).not.toContain("preflight-task");
    expect(frozenTaskIds).not.toContain("dry-run-phase");
  });
});

describe("Analysis v1 cell aggregation reaches the runner intact", () => {
  it("3 valid -> ordinary majority", () => {
    const report = runFrozenAnalysis({
      states: campaign([{ native: [true, true, false], maf: [false, false, true] }]),
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(report.taskLevelDescriptive.native.determinateCells).toBe(1);
    expect(report.taskLevelDescriptive.native.dvsCells).toBe(1);
    expect(report.taskLevelDescriptive.maf.dvsCells).toBe(0);
  });

  it("2 valid identical -> determinate common value", () => {
    const report = runFrozenAnalysis({
      states: campaign([
        {
          native: [true, true, false],
          nativeValid: [true, true, false],
          maf: [true, true, true],
        },
      ]),
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(report.taskLevelDescriptive.native.determinateCells).toBe(1);
    expect(report.taskLevelDescriptive.native.dvsCells).toBe(1);
    expect(report.pairs[0]?.native.status).toBe("DETERMINATE");
    expect(report.pairs[0]?.native.reducedN).toBe(true);
  });

  it("2 valid split -> UNRESOLVED (never imputed)", () => {
    const report = runFrozenAnalysis({
      states: campaign([
        { native: [true, false, false], nativeValid: [true, true, false], maf: [true, true, true] },
      ]),
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(report.pairs[0]?.native.status).toBe("UNRESOLVED");
    expect(report.taskLevelDescriptive.native.unresolvedCells).toBe(1);
  });

  it("1 valid -> UNRESOLVED", () => {
    const report = runFrozenAnalysis({
      states: campaign([
        {
          native: [true, false, false],
          nativeValid: [true, false, false],
          maf: [true, true, true],
        },
      ]),
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(report.pairs[0]?.native.status).toBe("UNRESOLVED");
  });

  it("0 valid with observations -> INVALID_CELL", () => {
    const report = runFrozenAnalysis({
      states: campaign([
        {
          native: [false, false, false],
          nativeValid: [false, false, false],
          maf: [true, true, true],
        },
      ]),
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(report.pairs[0]?.native.status).toBe("INVALID_CELL");
    expect(report.taskLevelDescriptive.native.invalidCells).toBe(1);
  });

  it("0 observations -> UNOBSERVED", () => {
    const report = runFrozenAnalysis({
      states: [],
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(report.pairs[0]?.native.status).toBe("UNOBSERVED");
    expect(report.taskLevelDescriptive.native.unobservedCells).toBe(1);
  });
});

describe("paired inference through the binding", () => {
  it("includes a task only when BOTH arms are determinate", () => {
    const report = runFrozenAnalysis({
      states: campaign([
        { native: [true, true, true], maf: [true, true, true] }, // eligible
        {
          native: [true, false, false],
          nativeValid: [true, true, false],
          maf: [true, true, true],
        }, // NATIVE unresolved -> excluded
      ]),
      frozenTaskIds: ["task-0", "task-1"],
      taskIds: ["task-0", "task-1"],
      runsPerTask: 3,
      expectedSlots: 12,
    });
    expect(report.pairedInference.eligibleTaskCount).toBe(1);
    expect(report.pairedInference.excludedTaskCount).toBe(1);
    expect(report.pairs[1]?.exclusionReason).toBe("UNRESOLVED_NATIVE");
  });

  it("computes exact McNemar over discordant task pairs", () => {
    // Frozen convention (EXPERIMENT_ANALYSIS_V1.md): n10 = Native-only DVS, n01 = MAF-only DVS.
    // MAF wins all 3 discordant tasks -> n01=3, n10=0, two-sided exact p = 2*(1/8) = 0.25.
    const report = runFrozenAnalysis({
      states: campaign([
        { native: [false, false, false], maf: [true, true, true] },
        { native: [false, false, false], maf: [true, true, true] },
        { native: [false, false, false], maf: [true, true, true] },
      ]),
      frozenTaskIds: ["task-0", "task-1", "task-2"],
      taskIds: ["task-0", "task-1", "task-2"],
      runsPerTask: 3,
      expectedSlots: 18,
    });
    const mc = report.pairedInference.mcnemar;
    expect(mc?.n01).toBe(3);
    expect(mc?.n10).toBe(0);
    expect(mc?.discordantPairs).toBe(3);
    expect(mc?.pValue).toBeCloseTo(0.25, 12);
  });

  it("orients the difference as MAF minus Native", () => {
    // Native wins both discordant tasks: the difference must be NEGATIVE.
    const report = runFrozenAnalysis({
      states: campaign([
        { native: [true, true, true], maf: [false, false, false] },
        { native: [true, true, true], maf: [false, false, false] },
        { native: [true, true, true], maf: [true, true, true] },
      ]),
      frozenTaskIds: ["task-0", "task-1", "task-2"],
      taskIds: ["task-0", "task-1", "task-2"],
      runsPerTask: 3,
      expectedSlots: 18,
    });
    expect(report.pairedInference.mcnemar?.n10).toBe(2);
    expect(report.pairedInference.mcnemar?.n01).toBe(0);
    expect(report.pairedInference.difference).toBeLessThan(0);
    const ci = report.pairedInference.differenceInterval;
    if (ci.status === "DETERMINED") expect(ci.estimate).toBeCloseTo(-2 / 3, 12);
  });

  it("reports p=1 on zero discordance without calling it equivalence", () => {
    const report = runFrozenAnalysis({
      states: campaign([
        { native: [true, true, true], maf: [true, true, true] },
        { native: [true, true, true], maf: [true, true, true] },
      ]),
      frozenTaskIds: ["task-0", "task-1"],
      taskIds: ["task-0", "task-1"],
      runsPerTask: 3,
      expectedSlots: 12,
    });
    const mc = report.pairedInference.mcnemar;
    expect(mc?.discordantPairs).toBe(0);
    expect(mc?.pValue).toBe(1);
    expect(mc?.zeroDiscordance).toBe(true);
    expect(mc?.detail).toMatch(/not evidence of equivalence/iu);
  });

  it("produces a Newcombe Method 10 difference interval, MAF minus Native", () => {
    const report = runFrozenAnalysis({
      states: campaign([
        { native: [false, false, false], maf: [true, true, true] },
        { native: [true, true, true], maf: [true, true, true] },
        { native: [false, false, false], maf: [true, true, true] },
        { native: [true, true, true], maf: [true, true, true] },
      ]),
      frozenTaskIds: ["task-0", "task-1", "task-2", "task-3"],
      taskIds: ["task-0", "task-1", "task-2", "task-3"],
      runsPerTask: 3,
      expectedSlots: 24,
    });
    const ci = report.pairedInference.differenceInterval;
    expect(ci.status).toBe("DETERMINED");
    if (ci.status === "DETERMINED") {
      expect(ci.method).toBe("NEWCOMBE_1998_STAT_MED_17_2635_METHOD_10");
      expect(ci.confidenceLevel).toBe(0.95);
      expect(ci.z).toBeCloseTo(1.959963984540054, 12);
      // MAF passed all 4 tasks, Native 2 of 4 -> difference is +0.5, and the interval brackets it.
      expect(ci.estimate).toBeCloseTo(0.5, 12);
      expect(ci.lower).toBeLessThan(ci.estimate);
      expect(ci.upper).toBeGreaterThan(ci.estimate);
      expect(ci.lower).toBeGreaterThanOrEqual(-1);
      expect(ci.upper).toBeLessThanOrEqual(1);
    }
  });
});

describe("primary metric is run-level and denominators are NOT equalized", () => {
  it("keeps each arm's own valid-run denominator", () => {
    // NATIVE loses one replicate to infrastructure; MAF keeps all three.
    const report = runFrozenAnalysis({
      states: campaign([
        {
          native: [true, true, false],
          nativeValid: [true, true, false],
          maf: [true, false, false],
        },
      ]),
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(report.runLevel.native.validRuns).toBe(2);
    expect(report.runLevel.native.invalidRuns).toBe(1);
    expect(report.runLevel.native.dvsCount).toBe(2);
    expect(report.runLevel.native.rate).toBe(1);

    expect(report.runLevel.maf.validRuns).toBe(3);
    expect(report.runLevel.maf.dvsCount).toBe(1);
    expect(report.runLevel.maf.rate).toBeCloseTo(1 / 3, 12);
  });

  it("never counts an invalid run as a failure in the valid denominator", () => {
    const allInvalid = runFrozenAnalysis({
      states: campaign([
        {
          native: [false, false, false],
          nativeValid: [false, false, false],
          maf: [true, true, true],
        },
      ]),
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    });
    expect(allInvalid.runLevel.native.validRuns).toBe(0);
    expect(allInvalid.runLevel.native.rate).toBeNull();
    expect(allInvalid.runLevel.native.invalidRuns).toBe(3);
  });
});

describe("provisional vs final reporting", () => {
  it("stays PROVISIONAL while observations are missing", () => {
    const report = runFrozenAnalysis({
      states: campaign([{ native: [true, true, true], maf: [true, true, true] }]),
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 174,
    });
    expect(report.reportStatus).toBe("PROVISIONAL");
    expect(report.stoppingDecisionUse).toBe("NOT_FOR_STOPPING_DECISIONS");
  });

  it("becomes FINAL only when complete AND explicitly allowed", () => {
    const states = campaign([{ native: [true, true, true], maf: [true, true, true] }]);
    const input = {
      states,
      frozenTaskIds: ["task-0"],
      taskIds: ["task-0"],
      runsPerTask: 3,
      expectedSlots: 6,
    };
    expect(runFrozenAnalysis(input).reportStatus).toBe("PROVISIONAL");
    expect(runFrozenAnalysis({ ...input, allowFinal: true }).reportStatus).toBe("FINAL");
  });
});
