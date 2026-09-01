#!/usr/bin/env node
// Deterministic randomization generator for evaluation/experiments/native-vs-maf-v1.json.
//
// Produces the frozen task order and per-task arm order (Phase 6 of EXPERIMENT_PROTOCOL.md) from a
// fixed seed and the frozen 29-task suite membership in evaluation/contracts/tasks.json. Running this
// script again with the same seed and the same task list reproduces byte-identical output; that is
// the point. It is checked in for audit, not run as part of scoring.
//
// Usage: node evaluation/experiments/generate-randomization.mjs [--check]
//   --check   verify evaluation/experiments/randomization.json matches what this script produces,
//             without writing anything. Exits non-zero on mismatch.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

export const RANDOMIZATION_SEED = "maf-experiment-protocol-v1-native-vs-maf-2026-09-01";

/** xmur3 string hash -> 32-bit seed. Deterministic, no external dependency. */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG. Deterministic given a 32-bit integer seed. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seededRandom = (seedString) => {
  const seedFn = xmur3(seedString);
  return mulberry32(seedFn());
};

/** Fisher-Yates shuffle using the supplied deterministic RNG. Does not mutate the input. */
export const deterministicShuffle = (items, rng) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

/**
 * Builds the frozen randomization: a shuffled task order plus a counterbalanced arm order.
 *
 * Arm order is derived from shuffled position parity, not a second RNG draw: position 0, 2, 4, ...
 * runs NATIVE_FIRST and position 1, 3, 5, ... runs MAF_FIRST. This guarantees an exact (or
 * off-by-one, for an odd task count) 50/50 counterbalance rather than leaving it to chance, while
 * still being derived from the same deterministic shuffle as the task order.
 */
export const buildRandomization = (taskIds, seed = RANDOMIZATION_SEED) => {
  const rng = seededRandom(seed);
  const taskOrder = deterministicShuffle(taskIds, rng);
  const armOrder = Object.fromEntries(
    taskOrder.map((taskId, index) => [taskId, index % 2 === 0 ? "NATIVE_FIRST" : "MAF_FIRST"]),
  );
  return { seed, taskOrder, armOrder };
};

const loadFrozenTaskIds = async () => {
  const tasksPath = path.join(repoRoot, "evaluation", "contracts", "tasks.json");
  const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
  return tasks.map((task) => task.id);
};

const main = async () => {
  const taskIds = await loadFrozenTaskIds();
  if (taskIds.length !== 29) {
    throw new Error(
      `Expected 29 frozen tasks in evaluation/contracts/tasks.json, found ${taskIds.length}`,
    );
  }
  const randomization = buildRandomization(taskIds);
  const outputPath = path.join(repoRoot, "evaluation", "experiments", "randomization.json");
  const serialized = `${JSON.stringify(randomization, null, 2)}\n`;

  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const existing = await readFile(outputPath, "utf8").catch(() => null);
    if (existing !== serialized) {
      process.stderr.write(
        "evaluation/experiments/randomization.json does not match the deterministic regeneration of the frozen seed and task list.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write("randomization.json matches the deterministic regeneration.\n");
    return;
  }

  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(`Wrote ${outputPath}\n`);
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
