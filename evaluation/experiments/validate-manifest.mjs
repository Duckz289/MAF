#!/usr/bin/env node
// Deterministic validation for evaluation/experiments/native-vs-maf-v1.json.
//
// Runs no frontier model and touches no frozen benchmark material. It only checks that the
// pre-registered experiment manifest is internally consistent and matches the frozen suite
// identity, before any scoring run can be considered ready.
//
// Usage: node evaluation/experiments/validate-manifest.mjs

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRandomization } from "./generate-randomization.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const failures = [];
const fail = (message) => failures.push(message);

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));

const manifest = await readJson("evaluation/experiments/native-vs-maf-v1.json");
const frozenTasks = await readJson("evaluation/contracts/tasks.json");
const randomization = await readJson("evaluation/experiments/randomization.json");

// --- exactly the intended 29 task IDs, no duplicates ------------------------------------------
const frozenTaskIds = frozenTasks.map((task) => task.id);
if (frozenTaskIds.length !== 29) {
  fail(`evaluation/contracts/tasks.json has ${frozenTaskIds.length} tasks, expected 29`);
}
if (new Set(frozenTaskIds).size !== frozenTaskIds.length) {
  fail("evaluation/contracts/tasks.json contains duplicate task IDs");
}
if (manifest.frozenSuite?.taskCount !== 29) {
  fail(`manifest frozenSuite.taskCount is ${manifest.frozenSuite?.taskCount}, expected 29`);
}

// --- frozen suite identity exact -----------------------------------------------------------
if (manifest.frozenSuite?.tag !== "maf-suite-freeze-v1") {
  fail(
    `manifest frozenSuite.tag is "${manifest.frozenSuite?.tag}", expected "maf-suite-freeze-v1"`,
  );
}
let resolvedTagCommit = null;
try {
  resolvedTagCommit = execFileSync("git", ["rev-parse", "maf-suite-freeze-v1^{commit}"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
} catch {
  fail("could not resolve the maf-suite-freeze-v1 tag in this repository");
}
if (resolvedTagCommit && resolvedTagCommit !== manifest.frozenSuite?.sha) {
  fail(
    `manifest frozenSuite.sha "${manifest.frozenSuite?.sha}" does not match the commit maf-suite-freeze-v1 currently resolves to ("${resolvedTagCommit}")`,
  );
}
if (manifest.frozenSuite?.immutable !== true) {
  fail("manifest frozenSuite.immutable must be true");
}

// --- both arms represented, with no cross-arm leakage of private material ---------------------
const arms = manifest.arms ?? {};
if (!arms.NATIVE || !arms.MAF) {
  fail("manifest must define both NATIVE and MAF arms");
}
if (arms.NATIVE?.benchmarkStrategy !== "NATIVE") {
  fail('NATIVE arm benchmarkStrategy must be "NATIVE"');
}
if (arms.MAF?.benchmarkStrategy !== "MAF_ADAPTIVE") {
  fail('MAF arm benchmarkStrategy must be "MAF_ADAPTIVE"');
}
const serializedArms = JSON.stringify(arms);
for (const forbidden of ["/curator/", "grader.mjs", "reference", "shortcut"]) {
  if (serializedArms.includes(forbidden)) {
    fail(
      `manifest arm definitions must not reference private grader material (found "${forbidden}")`,
    );
  }
}

// --- run count valid --------------------------------------------------------------------------
if (!Number.isInteger(manifest.runsPerTask) || manifest.runsPerTask < 1) {
  fail("manifest runsPerTask must be a positive integer");
}
const expectedTotal = frozenTaskIds.length * 2 * manifest.runsPerTask;
if (manifest.totalScoringRunsPlanned !== expectedTotal) {
  fail(
    `manifest totalScoringRunsPlanned is ${manifest.totalScoringRunsPlanned}, expected ${expectedTotal} (29 tasks x 2 arms x runsPerTask)`,
  );
}

// --- randomization deterministic and covers exactly the frozen task set -----------------------
const regenerated = buildRandomization(frozenTaskIds, randomization.seed);
if (JSON.stringify(regenerated) !== JSON.stringify(randomization)) {
  fail(
    "evaluation/experiments/randomization.json does not match a deterministic regeneration from its own seed and the current frozen task list",
  );
}
if (manifest.randomization?.seedSource !== "evaluation/experiments/generate-randomization.mjs") {
  fail("manifest randomization.seedSource must point at the generator script");
}
const taskOrderSet = new Set(randomization.taskOrder);
if (
  taskOrderSet.size !== frozenTaskIds.length ||
  frozenTaskIds.some((id) => !taskOrderSet.has(id))
) {
  fail("randomization.json taskOrder does not exactly cover the frozen 29 task IDs");
}
const armOrderKeys = new Set(Object.keys(randomization.armOrder ?? {}));
if (
  armOrderKeys.size !== frozenTaskIds.length ||
  frozenTaskIds.some((id) => !armOrderKeys.has(id))
) {
  fail("randomization.json armOrder does not exactly cover the frozen 29 task IDs");
}
const armOrderValues = Object.values(randomization.armOrder ?? {});
if (armOrderValues.some((value) => value !== "NATIVE_FIRST" && value !== "MAF_FIRST")) {
  fail('randomization.json armOrder values must be "NATIVE_FIRST" or "MAF_FIRST"');
}
const nativeFirstCount = armOrderValues.filter((value) => value === "NATIVE_FIRST").length;
const mafFirstCount = armOrderValues.filter((value) => value === "MAF_FIRST").length;
if (Math.abs(nativeFirstCount - mafFirstCount) > 1) {
  fail(
    `randomization.json armOrder is not counterbalanced: ${nativeFirstCount} NATIVE_FIRST vs ${mafFirstCount} MAF_FIRST`,
  );
}

// --- no unknown metric names --------------------------------------------------------------
const knownMetrics = new Set([
  "DVS_RATE_AMONG_VALID_RUNS",
  "COST_PER_DVS",
  "MEAN_ELAPSED_OF_DVS_RUNS_TIME_TO_SAFE",
  "INVALID_RUN_RATE",
  "HIDDEN_GRADER_PASS_RATE",
  "REGRESSION_PASS_RATE",
  "CANDIDATE_INTEGRITY_FAILURE_RATE",
  "FALSE_SAFE_RATE_AMONG_VALID_RUNS",
  "MAF_INTERVENTION_COUNT",
  "RETRY_COUNT",
  "EXECUTION_COST_USD",
  "VERIFICATION_COST_USD",
  "TOTAL_WALL_CLOCK_DURATION_MS",
  "DVS_RATE_AMONG_ALL_RUNS",
  "MEAN_ELAPSED_OF_VALID_RUNS",
  "BOTH_PASS",
  "MAF_ONLY_PASS",
  "NATIVE_ONLY_PASS",
  "BOTH_FAIL",
  "INVALID_MAF",
  "INVALID_NATIVE",
  "INVALID_BOTH",
  "COHERENCE_ISSUES_COUNT",
]);
const declaredMetrics = [
  ...(manifest.metrics?.primary ?? []),
  ...(manifest.metrics?.secondary ?? []),
  ...(manifest.metrics?.diagnostic ?? []),
];
if (declaredMetrics.length === 0) fail("manifest declares no metrics");
for (const metric of declaredMetrics) {
  if (!knownMetrics.has(metric)) fail(`manifest declares an unknown metric name: "${metric}"`);
}
if (new Set(declaredMetrics).size !== declaredMetrics.length) {
  fail("manifest declares the same metric name in more than one category");
}
if (
  manifest.metrics?.primary?.length !== 1 ||
  manifest.metrics.primary[0] !== "DVS_RATE_AMONG_VALID_RUNS"
) {
  fail('manifest primary metric must be exactly ["DVS_RATE_AMONG_VALID_RUNS"]');
}

// --- model configuration must be resolved, not a placeholder -----------------------------------
if (manifest.modelConfiguration?.resolved !== true) {
  fail("manifest modelConfiguration.resolved must be true before scoring can begin");
}
for (const field of ["model", "provider", "effort"]) {
  if (
    typeof manifest.modelConfiguration?.[field] !== "string" ||
    !manifest.modelConfiguration[field]
  ) {
    fail(`manifest modelConfiguration.${field} must be a non-empty string`);
  }
}

// --- timeout / budget must be concrete numbers, not TBD -----------------------------------------
if (!Number.isFinite(manifest.timeoutMs) || manifest.timeoutMs <= 0) {
  fail("manifest timeoutMs must be a positive number");
}
if (!Number.isFinite(manifest.budget?.perRunCeilingUsd) || manifest.budget.perRunCeilingUsd <= 0) {
  fail("manifest budget.perRunCeilingUsd must be a positive number");
}

// --- dry run must be excluded from the frozen suite and marked NON_SCORING ---------------------
if (
  manifest.dryRun?.status !== "NON_SCORING" ||
  manifest.dryRun?.tag !== "NOT_PART_OF_EXPERIMENT"
) {
  fail('manifest dryRun must be tagged status "NON_SCORING" and tag "NOT_PART_OF_EXPERIMENT"');
}
if (
  typeof manifest.dryRun?.taskSource !== "string" ||
  manifest.dryRun.taskSource.includes("phase-b") ||
  manifest.dryRun.taskSource.includes("phase-c")
) {
  fail("manifest dryRun.taskSource must not reference the frozen phase-b/phase-c suites");
}

if (failures.length > 0) {
  process.stderr.write("Experiment manifest validation FAILED:\n");
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Experiment manifest validation PASSED: 29 tasks, 2 arms, runsPerTask=${manifest.runsPerTask}, totalScoringRunsPlanned=${manifest.totalScoringRunsPlanned}, randomization deterministic and counterbalanced (${nativeFirstCount}/${mafFirstCount}).\n`,
  );
}
