#!/usr/bin/env node
// Deterministic validation for evaluation/experiments/native-vs-maf-v2.json.
//
// Runs no frontier model and touches no frozen benchmark material. Checks two things: (1) the v2
// manifest is internally consistent, exactly like validate-manifest.mjs checks v1, and (2) every
// experimental parameter the mission requires to stay identical between v1 and v2 actually is
// identical -- model, effort, N, timeout, budget, task IDs, randomization, metrics, stopping rule.
// The only permitted difference is real-execution implementation/provenance plumbing.
//
// Usage: node evaluation/experiments/validate-manifest-v2.mjs

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

const v1 = await readJson("evaluation/experiments/native-vs-maf-v1.json");
const v2 = await readJson("evaluation/experiments/native-vs-maf-v2.json");
const frozenTasks = await readJson("evaluation/contracts/tasks.json");
const randomization = await readJson("evaluation/experiments/randomization.json");

const frozenTaskIds = frozenTasks.map((task) => task.id);
if (frozenTaskIds.length !== 29) {
  fail(`evaluation/contracts/tasks.json has ${frozenTaskIds.length} tasks, expected 29`);
}

// --- v2 protocol identity ------------------------------------------------------------------
if (v2.protocolVersion !== "2.0.0-preregistered") {
  fail(`v2 manifest protocolVersion is "${v2.protocolVersion}", expected "2.0.0-preregistered"`);
}
if (v2.supersedes?.tag !== "maf-experiment-protocol-v1") {
  fail('v2 manifest supersedes.tag must be "maf-experiment-protocol-v1"');
}
let resolvedProtocolV1Commit = null;
try {
  resolvedProtocolV1Commit = execFileSync(
    "git",
    ["rev-parse", "maf-experiment-protocol-v1^{commit}"],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
} catch {
  fail("could not resolve the maf-experiment-protocol-v1 tag in this repository");
}
if (resolvedProtocolV1Commit && resolvedProtocolV1Commit !== v2.supersedes?.sha) {
  fail(
    `v2 manifest supersedes.sha "${v2.supersedes?.sha}" does not match the commit ` +
      `maf-experiment-protocol-v1 currently resolves to ("${resolvedProtocolV1Commit}")`,
  );
}

// --- frozen suite identity: byte-identical between v1 and v2 -------------------------------
for (const field of ["tag", "sha", "taskCount", "taskSource", "immutable"]) {
  if (JSON.stringify(v1.frozenSuite?.[field]) !== JSON.stringify(v2.frozenSuite?.[field])) {
    fail(
      `frozenSuite.${field} differs between v1 (${JSON.stringify(v1.frozenSuite?.[field])}) and ` +
        `v2 (${JSON.stringify(v2.frozenSuite?.[field])})`,
    );
  }
}
if (v2.frozenSuite?.tag !== "maf-suite-freeze-v1") {
  fail('v2 manifest frozenSuite.tag must be "maf-suite-freeze-v1"');
}
let resolvedSuiteCommit = null;
try {
  resolvedSuiteCommit = execFileSync("git", ["rev-parse", "maf-suite-freeze-v1^{commit}"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
} catch {
  fail("could not resolve the maf-suite-freeze-v1 tag in this repository");
}
if (resolvedSuiteCommit && resolvedSuiteCommit !== v2.frozenSuite?.sha) {
  fail(
    `v2 manifest frozenSuite.sha "${v2.frozenSuite?.sha}" does not match the commit ` +
      `maf-suite-freeze-v1 currently resolves to ("${resolvedSuiteCommit}")`,
  );
}

// --- model / effort / provider identical -----------------------------------------------------
for (const field of ["model", "provider", "effort", "thinking"]) {
  if (v1.modelConfiguration?.[field] !== v2.modelConfiguration?.[field]) {
    fail(
      `modelConfiguration.${field} differs between v1 ("${v1.modelConfiguration?.[field]}") and ` +
        `v2 ("${v2.modelConfiguration?.[field]}")`,
    );
  }
}
if (v2.modelConfiguration?.resolved !== true) {
  fail("v2 manifest modelConfiguration.resolved must be true before scoring can begin");
}

// --- N / timeout / budget identical ------------------------------------------------------------
if (v1.runsPerTask !== v2.runsPerTask) {
  fail(`runsPerTask differs between v1 (${v1.runsPerTask}) and v2 (${v2.runsPerTask})`);
}
if (v1.totalScoringRunsPlanned !== v2.totalScoringRunsPlanned) {
  fail(
    `totalScoringRunsPlanned differs between v1 (${v1.totalScoringRunsPlanned}) and v2 ` +
      `(${v2.totalScoringRunsPlanned})`,
  );
}
const expectedTotal = frozenTaskIds.length * 2 * v2.runsPerTask;
if (v2.totalScoringRunsPlanned !== expectedTotal) {
  fail(
    `v2 manifest totalScoringRunsPlanned is ${v2.totalScoringRunsPlanned}, expected ${expectedTotal}`,
  );
}
if (v1.timeoutMs !== v2.timeoutMs) {
  fail(`timeoutMs differs between v1 (${v1.timeoutMs}) and v2 (${v2.timeoutMs})`);
}
if (
  v1.budget?.perRunCeilingUsd !== v2.budget?.perRunCeilingUsd ||
  v1.budget?.mode !== v2.budget?.mode
) {
  fail(
    `budget differs between v1 (${JSON.stringify(v1.budget)}) and v2 (${JSON.stringify(v2.budget)})`,
  );
}

// --- arm identity (benchmarkStrategy, identity block) identical, only realExecution may differ --
for (const armName of ["NATIVE", "MAF"]) {
  const a = v1.arms?.[armName] ?? {};
  const b = v2.arms?.[armName] ?? {};
  if (a.benchmarkStrategy !== b.benchmarkStrategy) {
    fail(`arms.${armName}.benchmarkStrategy differs between v1 and v2`);
  }
  if (JSON.stringify(a.identity) !== JSON.stringify(b.identity)) {
    fail(`arms.${armName}.identity differs between v1 and v2`);
  }
  if (a.orchestration !== b.orchestration) {
    fail(`arms.${armName}.orchestration differs between v1 and v2`);
  }
}
const serializedArmsV2 = JSON.stringify(v2.arms ?? {});
for (const forbidden of ["/curator/", "grader.mjs", "reference", "shortcut"]) {
  if (serializedArmsV2.includes(forbidden)) {
    fail(
      `v2 manifest arm definitions must not reference private grader material (found "${forbidden}")`,
    );
  }
}

// --- randomization: v2 must reuse v1's file byte-for-byte, not regenerate ----------------------
if (v2.randomization?.manifestFile !== v1.randomization?.manifestFile) {
  fail(
    "v2 manifest randomization.manifestFile must be the same file v1 uses (reused, not regenerated)",
  );
}
const regenerated = buildRandomization(frozenTaskIds, randomization.seed);
if (JSON.stringify(regenerated) !== JSON.stringify(randomization)) {
  fail(
    "evaluation/experiments/randomization.json does not match a deterministic regeneration from its own seed and the current frozen task list",
  );
}
if (randomization.seed !== "maf-experiment-protocol-v1-native-vs-maf-2026-09-01") {
  fail(
    "randomization.json seed changed from the v1 frozen seed; v2 must reuse the exact v1 randomization ordering unless a change is explicitly justified and this validator updated to match",
  );
}

// --- metrics identical --------------------------------------------------------------------------
for (const category of ["primary", "secondary", "diagnostic"]) {
  const a = [...(v1.metrics?.[category] ?? [])].sort();
  const b = [...(v2.metrics?.[category] ?? [])].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail(`metrics.${category} differs between v1 and v2`);
  }
}

// --- stopping rule / contamination rule / invalid-run policy identical -------------------------
if (JSON.stringify(v1.stoppingRule) !== JSON.stringify(v2.stoppingRule)) {
  fail("stoppingRule differs between v1 and v2");
}
if (JSON.stringify(v1.invalidRunPolicy) !== JSON.stringify(v2.invalidRunPolicy)) {
  fail("invalidRunPolicy differs between v1 and v2");
}

// --- real preflight must be tagged NON_SCORING / NOT_PART_OF_EXPERIMENT and scoped -------------
if (
  v2.realPreflight?.status !== "NON_SCORING" ||
  v2.realPreflight?.tag !== "NOT_PART_OF_EXPERIMENT"
) {
  fail(
    'v2 manifest realPreflight must be tagged status "NON_SCORING" and tag "NOT_PART_OF_EXPERIMENT"',
  );
}
if (
  typeof v2.realPreflight?.taskSource !== "string" ||
  v2.realPreflight.taskSource.includes("phase-b") ||
  v2.realPreflight.taskSource.includes("phase-c")
) {
  fail("v2 manifest realPreflight.taskSource must not reference the frozen phase-b/phase-c suites");
}
if (
  typeof v2.realPreflight?.billedConfirmationFlag !== "string" ||
  !v2.realPreflight.billedConfirmationFlag
) {
  fail("v2 manifest realPreflight.billedConfirmationFlag must be declared");
}

// --- no protocol v2 freeze tag exists yet --------------------------------------------------------
try {
  execFileSync("git", ["rev-parse", "--verify", "maf-experiment-protocol-v2"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  fail(
    "a maf-experiment-protocol-v2 tag already exists; protocol v2 must not be frozen by this mission",
  );
} catch {
  // Expected: the tag must not exist yet.
}

if (failures.length > 0) {
  process.stderr.write("Experiment manifest v1/v2 validation FAILED:\n");
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Experiment manifest v1/v2 validation PASSED: frozen suite identical, model/effort/N/timeout/budget " +
      "identical, randomization reused unchanged, metrics/stopping-rule/invalid-run-policy identical, " +
      "no protocol v2 freeze tag exists yet.\n",
  );
}
