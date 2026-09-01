// Deterministic 174-slot scoring schedule, derived entirely from frozen artifacts.
//
// NOTHING here randomizes. The task order and the per-task first-arm order are READ from
// evaluation/experiments/randomization.json, which is itself the frozen, seed-reproducible output of
// evaluation/experiments/generate-randomization.mjs (`--check` proves it regenerates byte-identical
// from the frozen seed). This module never calls Math.random, never shuffles, and never consults the
// clock: the same frozen inputs always produce the same 174 slots in the same order.
//
// ONE degree of freedom the frozen protocol does not pin: how the 3 replicates interleave with the
// task order. The protocol fixes WHICH tasks run, in WHICH order, and WHICH arm goes first within a
// task; it defines the analysis in terms of the "task-arm cell" and never in terms of replicate
// adjacency. This runner nests replicate inside task (task -> replicate -> arm), which keeps a
// task's six observations contiguous and therefore makes the protocol's own natural batch unit (one
// task = 3 NATIVE + 3 MAF) expressible without reordering anything. This choice cannot affect any
// frozen statistic: every metric is computed per task-arm cell, which is invariant to the order the
// cells are filled in. It is recorded explicitly as `replicateNesting` so an auditor never has to
// infer it.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROTOCOL_V2_SHA, SUITE_SHA } from "./frozen-refs";

export type Arm = "NATIVE" | "MAF";
export type ArmOrder = "NATIVE_FIRST" | "MAF_FIRST";

export interface FrozenRandomization {
  seed: string;
  taskOrder: string[];
  armOrder: Record<string, ArmOrder>;
}

export interface RunSlot {
  /** Deterministic, human-readable slot identity. Stable across processes and machines. */
  slotId: string;
  /** Deterministic digest binding the slot to the exact frozen suite + protocol it belongs to. */
  slotDigest: string;
  taskId: string;
  arm: Arm;
  /** 1-based repetition index within the task-arm cell (frozen N=3). */
  replicate: number;
  /** 0-based position of the task within the frozen task order. */
  randomizationPosition: number;
  /** The frozen first-arm order for this task. */
  armOrder: ArmOrder;
  /** 0-based position of this slot in the full deterministic execution sequence (0..173). */
  sequencePosition: number;
  suiteSha: string;
  protocolSha: string;
}

export interface ScoringSchedule {
  suiteSha: string;
  protocolSha: string;
  randomizationSeed: string;
  taskCount: number;
  runsPerTask: number;
  replicateNesting: "TASK_THEN_REPLICATE_THEN_ARM";
  slots: RunSlot[];
  /** Digest over the entire ordered schedule. Two runners agree iff these match. */
  scheduleDigest: string;
}

export const SLOT_IDENTITY_NAMESPACE = "maf-scoring-slot/v1";
export const SCHEDULE_IDENTITY_NAMESPACE = "maf-scoring-schedule/v1";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The slot's cryptographic identity.
 *
 * Binding suiteSha and protocolSha into the digest is what makes a slot identity meaningful rather
 * than merely unique: "task X / NATIVE / replicate 2" is a different experimental observation if the
 * suite or the protocol changed, and a state store keyed on this digest can therefore never silently
 * merge results collected under different frozen artifacts.
 */
export const computeSlotDigest = (input: {
  suiteSha: string;
  protocolSha: string;
  taskId: string;
  arm: Arm;
  replicate: number;
}): string =>
  sha256Hex(
    [
      SLOT_IDENTITY_NAMESPACE,
      input.suiteSha,
      input.protocolSha,
      input.taskId,
      input.arm,
      `r${input.replicate}`,
    ].join("\n"),
  );

/** Human-readable slot id. Filesystem-safe: task ids are kebab-case, arm is NATIVE|MAF. */
export const computeSlotId = (taskId: string, arm: Arm, replicate: number): string =>
  `${taskId}__${arm}__r${replicate}`;

const SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*__(?:NATIVE|MAF)__r[1-9][0-9]*$/u;

/** Guards against a slot id ever being used as an unchecked path segment. */
export const isWellFormedSlotId = (slotId: string): boolean => SLOT_ID_PATTERN.test(slotId);

export const parseSlotId = (
  slotId: string,
): { taskId: string; arm: Arm; replicate: number } | null => {
  if (!isWellFormedSlotId(slotId)) return null;
  const parts = slotId.split("__");
  const [taskId, arm, replicatePart] = parts;
  if (taskId === undefined || arm === undefined || replicatePart === undefined) return null;
  const replicate = Number.parseInt(replicatePart.slice(1), 10);
  if (!Number.isInteger(replicate) || replicate < 1) return null;
  return { taskId, arm: arm as Arm, replicate };
};

export const loadFrozenRandomization = async (repoRoot: string): Promise<FrozenRandomization> => {
  const randomizationPath = path.join(repoRoot, "evaluation", "experiments", "randomization.json");
  const parsed = JSON.parse(await readFile(randomizationPath, "utf8")) as FrozenRandomization;
  if (typeof parsed.seed !== "string" || !Array.isArray(parsed.taskOrder)) {
    throw new Error("randomization.json is malformed: expected { seed, taskOrder, armOrder }");
  }
  return parsed;
};

export const loadFrozenTaskIds = async (repoRoot: string): Promise<string[]> => {
  const tasksPath = path.join(repoRoot, "evaluation", "contracts", "tasks.json");
  const tasks = JSON.parse(await readFile(tasksPath, "utf8")) as Array<{ id: string }>;
  return tasks.map((task) => task.id);
};

export interface BuildScheduleInput {
  randomization: FrozenRandomization;
  /** The frozen suite's task ids. Used to prove the randomization covers exactly the frozen suite. */
  frozenTaskIds: readonly string[];
  runsPerTask: number;
  suiteSha?: string;
  protocolSha?: string;
}

/**
 * Builds the complete deterministic schedule.
 *
 * Validates membership BOTH ways: every frozen task appears exactly once in the randomization, and
 * the randomization introduces no task the frozen suite does not contain. A one-way check would let
 * a substituted task pass as long as the count stayed right.
 */
export const buildScoringSchedule = (input: BuildScheduleInput): ScoringSchedule => {
  const { randomization, frozenTaskIds, runsPerTask } = input;
  const suiteSha = input.suiteSha ?? SUITE_SHA;
  const protocolSha = input.protocolSha ?? PROTOCOL_V2_SHA;

  if (!Number.isInteger(runsPerTask) || runsPerTask < 1) {
    throw new Error(`runsPerTask must be a positive integer, received ${runsPerTask}`);
  }

  const ordered = randomization.taskOrder;
  const orderedSet = new Set(ordered);
  if (orderedSet.size !== ordered.length) {
    throw new Error("frozen randomization taskOrder contains duplicate task ids");
  }
  const frozenSet = new Set(frozenTaskIds);
  if (frozenSet.size !== frozenTaskIds.length) {
    throw new Error("frozen suite contains duplicate task ids");
  }
  const missing = [...frozenSet].filter((id) => !orderedSet.has(id));
  const extra = [...orderedSet].filter((id) => !frozenSet.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `frozen randomization does not match the frozen suite (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
    );
  }

  const slots: RunSlot[] = [];
  let sequencePosition = 0;

  ordered.forEach((taskId, randomizationPosition) => {
    const armOrder = randomization.armOrder[taskId];
    if (armOrder !== "NATIVE_FIRST" && armOrder !== "MAF_FIRST") {
      throw new Error(`frozen randomization has no valid armOrder for task ${taskId}`);
    }
    // The frozen first-arm order for this task, applied identically to every replicate.
    const armsInOrder: Arm[] = armOrder === "NATIVE_FIRST" ? ["NATIVE", "MAF"] : ["MAF", "NATIVE"];

    for (let replicate = 1; replicate <= runsPerTask; replicate += 1) {
      for (const arm of armsInOrder) {
        slots.push({
          slotId: computeSlotId(taskId, arm, replicate),
          slotDigest: computeSlotDigest({ suiteSha, protocolSha, taskId, arm, replicate }),
          taskId,
          arm,
          replicate,
          randomizationPosition,
          armOrder,
          sequencePosition,
          suiteSha,
          protocolSha,
        });
        sequencePosition += 1;
      }
    }
  });

  const scheduleDigest = sha256Hex(
    [
      SCHEDULE_IDENTITY_NAMESPACE,
      suiteSha,
      protocolSha,
      randomization.seed,
      `runsPerTask=${runsPerTask}`,
      ...slots.map((slot) => `${slot.sequencePosition}:${slot.slotId}:${slot.slotDigest}`),
    ].join("\n"),
  );

  return {
    suiteSha,
    protocolSha,
    randomizationSeed: randomization.seed,
    taskCount: ordered.length,
    runsPerTask,
    replicateNesting: "TASK_THEN_REPLICATE_THEN_ARM",
    slots,
    scheduleDigest,
  };
};

export interface ScheduleSummary {
  taskCount: number;
  nativeRuns: number;
  mafRuns: number;
  totalRuns: number;
  nativeFirstTasks: number;
  mafFirstTasks: number;
  duplicateSlotIds: string[];
  tasksWithWrongReplicateCount: string[];
}

/** Independent recount of a built schedule, used by the CLI and by tests as a cross-check. */
export const summarizeSchedule = (schedule: ScoringSchedule): ScheduleSummary => {
  const seen = new Map<string, number>();
  for (const slot of schedule.slots) {
    seen.set(slot.slotId, (seen.get(slot.slotId) ?? 0) + 1);
  }
  const perCell = new Map<string, number>();
  for (const slot of schedule.slots) {
    const key = `${slot.taskId}::${slot.arm}`;
    perCell.set(key, (perCell.get(key) ?? 0) + 1);
  }
  const tasksWithWrongReplicateCount = [...perCell.entries()]
    .filter(([, count]) => count !== schedule.runsPerTask)
    .map(([key]) => key);

  const tasks = new Set(schedule.slots.map((slot) => slot.taskId));
  const firstArmByTask = new Map<string, ArmOrder>();
  for (const slot of schedule.slots) firstArmByTask.set(slot.taskId, slot.armOrder);

  return {
    taskCount: tasks.size,
    nativeRuns: schedule.slots.filter((slot) => slot.arm === "NATIVE").length,
    mafRuns: schedule.slots.filter((slot) => slot.arm === "MAF").length,
    totalRuns: schedule.slots.length,
    nativeFirstTasks: [...firstArmByTask.values()].filter((o) => o === "NATIVE_FIRST").length,
    mafFirstTasks: [...firstArmByTask.values()].filter((o) => o === "MAF_FIRST").length,
    duplicateSlotIds: [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id),
    tasksWithWrongReplicateCount,
  };
};

/**
 * Deterministic batch slicing (mission Phase 13).
 *
 * A batch is a contiguous window of the ALREADY-ORDERED schedule. It cannot reshuffle, change N,
 * change arm order or change task inclusion, because it never touches the slot array's order or
 * contents -- it only chooses where to start and stop.
 */
export const selectBatch = (
  schedule: ScoringSchedule,
  options: { fromSequence?: number; limit?: number; taskIds?: readonly string[] },
): RunSlot[] => {
  let selected = schedule.slots;
  if (options.taskIds && options.taskIds.length > 0) {
    const wanted = new Set(options.taskIds);
    const unknown = [...wanted].filter((id) => !schedule.slots.some((slot) => slot.taskId === id));
    if (unknown.length > 0) {
      throw new Error(`unknown task id(s) for this frozen schedule: ${unknown.join(", ")}`);
    }
    selected = selected.filter((slot) => wanted.has(slot.taskId));
  }
  if (options.fromSequence !== undefined) {
    selected = selected.filter((slot) => slot.sequencePosition >= (options.fromSequence ?? 0));
  }
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 0) {
      throw new Error(`batch limit must be a non-negative integer, received ${options.limit}`);
    }
    selected = selected.slice(0, options.limit);
  }
  return selected;
};
