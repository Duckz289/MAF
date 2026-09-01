import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildScoringSchedule,
  computeSlotDigest,
  computeSlotId,
  isWellFormedSlotId,
  loadFrozenRandomization,
  loadFrozenTaskIds,
  parseSlotId,
  selectBatch,
  summarizeSchedule,
  type FrozenRandomization,
} from "../evaluation/experiments/scoring/lib/schedule";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const loadReal = async () => {
  const [randomization, frozenTaskIds] = await Promise.all([
    loadFrozenRandomization(repoRoot),
    loadFrozenTaskIds(repoRoot),
  ]);
  return buildScoringSchedule({ randomization, frozenTaskIds, runsPerTask: 3 });
};

describe("the frozen 174-run schedule", () => {
  it("produces exactly 29 tasks x 2 arms x 3 replicates", async () => {
    const summary = summarizeSchedule(await loadReal());
    expect(summary.taskCount).toBe(29);
    expect(summary.nativeRuns).toBe(87);
    expect(summary.mafRuns).toBe(87);
    expect(summary.totalRuns).toBe(174);
  });

  it("contains no duplicate slots and gives every task-arm cell exactly 3 replicates", async () => {
    const summary = summarizeSchedule(await loadReal());
    expect(summary.duplicateSlotIds).toEqual([]);
    expect(summary.tasksWithWrongReplicateCount).toEqual([]);
  });

  it("preserves the frozen 15 NATIVE_FIRST / 14 MAF_FIRST counterbalance", async () => {
    const summary = summarizeSchedule(await loadReal());
    expect(summary.nativeFirstTasks).toBe(15);
    expect(summary.mafFirstTasks).toBe(14);
  });

  it("preserves the frozen task order and per-task first-arm order", async () => {
    const randomization = await loadFrozenRandomization(repoRoot);
    const schedule = await loadReal();
    // Task order: first appearance of each task must follow randomization.json exactly.
    const firstAppearance: string[] = [];
    for (const slot of schedule.slots) {
      if (!firstAppearance.includes(slot.taskId)) firstAppearance.push(slot.taskId);
    }
    expect(firstAppearance).toEqual(randomization.taskOrder);

    // Arm order: within each task+replicate, the frozen first arm must actually go first.
    for (const taskId of randomization.taskOrder) {
      const forTask = schedule.slots.filter((slot) => slot.taskId === taskId);
      for (let replicate = 1; replicate <= 3; replicate += 1) {
        const pair = forTask
          .filter((slot) => slot.replicate === replicate)
          .sort((a, b) => a.sequencePosition - b.sequencePosition);
        const expectedFirst = randomization.armOrder[taskId] === "NATIVE_FIRST" ? "NATIVE" : "MAF";
        expect(pair[0]?.arm).toBe(expectedFirst);
      }
    }
  });

  it("is deterministic: rebuilding yields an identical schedule digest", async () => {
    const a = await loadReal();
    const b = await loadReal();
    expect(a.scheduleDigest).toBe(b.scheduleDigest);
    expect(a.slots.map((s) => s.slotId)).toEqual(b.slots.map((s) => s.slotId));
    expect(a.slots.map((s) => s.slotDigest)).toEqual(b.slots.map((s) => s.slotDigest));
  });

  it("assigns contiguous sequence positions 0..173", async () => {
    const schedule = await loadReal();
    expect(schedule.slots.map((s) => s.sequencePosition)).toEqual(
      Array.from({ length: 174 }, (_, i) => i),
    );
  });
});

describe("run slot identity", () => {
  it("is deterministic and independent of any random source", () => {
    const first = computeSlotDigest({
      suiteSha: "a".repeat(40),
      protocolSha: "b".repeat(40),
      taskId: "clamp-number-util",
      arm: "NATIVE",
      replicate: 2,
    });
    const second = computeSlotDigest({
      suiteSha: "a".repeat(40),
      protocolSha: "b".repeat(40),
      taskId: "clamp-number-util",
      arm: "NATIVE",
      replicate: 2,
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("binds the slot to its suite and protocol, so identity changes if either does", () => {
    const base = {
      suiteSha: "a".repeat(40),
      protocolSha: "b".repeat(40),
      taskId: "clamp-number-util",
      arm: "NATIVE" as const,
      replicate: 1,
    };
    expect(computeSlotDigest(base)).not.toBe(
      computeSlotDigest({ ...base, suiteSha: "c".repeat(40) }),
    );
    expect(computeSlotDigest(base)).not.toBe(
      computeSlotDigest({ ...base, protocolSha: "c".repeat(40) }),
    );
  });

  it("distinguishes arm and replicate", () => {
    const base = {
      suiteSha: "a".repeat(40),
      protocolSha: "b".repeat(40),
      taskId: "clamp-number-util",
    };
    const digests = new Set([
      computeSlotDigest({ ...base, arm: "NATIVE", replicate: 1 }),
      computeSlotDigest({ ...base, arm: "NATIVE", replicate: 2 }),
      computeSlotDigest({ ...base, arm: "MAF", replicate: 1 }),
      computeSlotDigest({ ...base, arm: "MAF", replicate: 2 }),
    ]);
    expect(digests.size).toBe(4);
  });

  it("round-trips the human-readable slot id", () => {
    const slotId = computeSlotId("b2-bulk-op-tenant-bypass", "MAF", 3);
    expect(slotId).toBe("b2-bulk-op-tenant-bypass__MAF__r3");
    expect(parseSlotId(slotId)).toEqual({
      taskId: "b2-bulk-op-tenant-bypass",
      arm: "MAF",
      replicate: 3,
    });
  });

  it("rejects slot ids that could escape a directory", () => {
    expect(isWellFormedSlotId("../../etc__NATIVE__r1")).toBe(false);
    expect(isWellFormedSlotId("task__NATIVE__r1/../..")).toBe(false);
    expect(isWellFormedSlotId("task__OTHER__r1")).toBe(false);
    expect(parseSlotId("../evil__NATIVE__r1")).toBeNull();
  });
});

describe("schedule integrity guards", () => {
  const randomization: FrozenRandomization = {
    seed: "seed",
    taskOrder: ["alpha", "beta"],
    armOrder: { alpha: "NATIVE_FIRST", beta: "MAF_FIRST" },
  };

  it("rejects a randomization that omits a frozen task", () => {
    expect(() =>
      buildScoringSchedule({
        randomization,
        frozenTaskIds: ["alpha", "beta", "gamma"],
        runsPerTask: 3,
      }),
    ).toThrow(/missing: gamma/u);
  });

  it("rejects a randomization that introduces a task outside the frozen suite", () => {
    expect(() =>
      buildScoringSchedule({ randomization, frozenTaskIds: ["alpha"], runsPerTask: 3 }),
    ).toThrow(/unexpected: beta/u);
  });

  it("rejects a task with no frozen arm order", () => {
    expect(() =>
      buildScoringSchedule({
        randomization: { ...randomization, armOrder: { alpha: "NATIVE_FIRST" } },
        frozenTaskIds: ["alpha", "beta"],
        runsPerTask: 3,
      }),
    ).toThrow(/no valid armOrder for task beta/u);
  });
});

describe("batching never alters the frozen schedule", () => {
  it("returns a contiguous prefix in unchanged order", async () => {
    const schedule = await loadReal();
    const batch = selectBatch(schedule, { limit: 6 });
    expect(batch).toEqual(schedule.slots.slice(0, 6));
  });

  it("keeps a task's six observations together as the natural batch unit", async () => {
    const schedule = await loadReal();
    const firstTask = schedule.slots[0]?.taskId as string;
    const batch = selectBatch(schedule, { taskIds: [firstTask] });
    expect(batch).toHaveLength(6);
    expect(batch.filter((s) => s.arm === "NATIVE")).toHaveLength(3);
    expect(batch.filter((s) => s.arm === "MAF")).toHaveLength(3);
  });

  it("resumes from a sequence position without reordering", async () => {
    const schedule = await loadReal();
    const batch = selectBatch(schedule, { fromSequence: 100, limit: 5 });
    expect(batch.map((s) => s.sequencePosition)).toEqual([100, 101, 102, 103, 104]);
  });

  it("the union of successive batches reconstructs the full schedule exactly", async () => {
    const schedule = await loadReal();
    const rebuilt = [];
    for (let from = 0; from < 174; from += 6) {
      rebuilt.push(...selectBatch(schedule, { fromSequence: from, limit: 6 }));
    }
    expect(rebuilt.map((s) => s.slotId)).toEqual(schedule.slots.map((s) => s.slotId));
  });

  it("refuses an unknown task filter rather than silently returning nothing", async () => {
    const schedule = await loadReal();
    expect(() => selectBatch(schedule, { taskIds: ["not-a-frozen-task"] })).toThrow(
      /unknown task id/u,
    );
  });
});
