// Determinism stress run.
//
// The independent audit of snapshot bb326527 found this script emitting properties as the literal
// string "PASS" -- staleModuleCache, sharedTempState, orderIndependence, cwdIndependence,
// deterministicSynchronization, filenameLeakage, contentLeakage, materialization and
// hiddenIsolation were all printed regardless of what the run observed.
//
// Every field below is now either a measured value or the literal NOT_CHECKED. Nothing is
// converted to PASS. Where a property is genuinely measured, the report states the measurement it
// rests on, so the number can be re-derived rather than trusted.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCase } from "./lib/curator-runner.mjs";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(evaluationRoot);
const rounds = Number(argument("--rounds", "14"));
const concurrency = Number(argument("--concurrency", "4"));
if (!Number.isInteger(rounds) || rounds < 2) throw new RangeError("rounds must be at least two");
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new RangeError("concurrency must be a positive integer");
}

const candidates = ["pristine", "reference", "wrong", "alternative", "attack"];
const expectedStatus = {
  pristine: "FAIL",
  reference: "PASS",
  wrong: "FAIL",
  alternative: "PASS",
  attack: "FAIL",
};

// Tasks whose fixtures hold module-level mutable state. If a grader process ever reused a module
// cache or a workspace, these are the cases whose outcomes would drift first, so their stability is
// the evidence behind the module-cache and shared-state properties.
const STATEFUL_TASKS = new Set([
  "pagination-cursor-feature",
  "stale-cache-invalidation-bug",
  "event-emitter-listener-leak",
  "inventory-orientation-task",
  "past-due-reminder-handling",
  "idempotency-key-race",
  "b2-bulk-op-tenant-bypass",
  "b2-concurrent-seat-lost-update",
  "b2-pending-write-visibility",
  "notification-settings-regression",
  "subscription-price-mismatch",
  "task-update-duplication",
  "completion-state-regression",
]);

// Tasks whose contract is about concurrent access. Their stability across every round at this
// concurrency is the evidence behind the synchronization property.
const CONCURRENCY_TASKS = new Set(["idempotency-key-race", "b2-concurrent-seat-lost-update"]);

const baseCases = [];
for (const phase of ["phase-b", "phase-c"]) {
  const manifest = await readJson(path.join(evaluationRoot, phase, "manifest.json"));
  const taskIds =
    phase === "phase-b" ? manifest.tasks.map(([id]) => id) : Object.values(manifest.bands).flat();
  const overlays = await loadOverlays(phase);
  for (const taskId of taskIds) {
    for (const candidate of candidates) {
      baseCases.push({
        key: `${phase}/${taskId}/${candidate}`,
        phase,
        taskId,
        candidate,
        expected: expectedStatus[candidate],
        overlayData: candidate === "pristine" ? undefined : overlays[candidate]?.[taskId],
      });
    }
  }
}
for (const item of baseCases) {
  if (item.candidate !== "pristine" && item.overlayData === undefined) {
    throw new Error(`${item.key}: missing overlay`);
  }
}

const jobs = [];
for (let round = 0; round < rounds; round += 1) {
  const offset = (round * 37) % baseCases.length;
  let ordered = baseCases.slice(offset).concat(baseCases.slice(0, offset));
  if (round % 2 === 1) ordered = ordered.reverse();
  for (const item of ordered) jobs.push({ ...item, round });
}

const fingerprints = new Map(baseCases.map((item) => [item.key, new Set()]));
const fingerprintsByCwd = new Map(baseCases.map((item) => [item.key, new Map()]));
const cwdCounts = new Map([
  [repositoryRoot, 0],
  [evaluationRoot, 0],
]);
const workspaces = new Set();
const graderPids = new Set();
const observations = {
  executions: 0,
  workspaceObservations: 0,
  pidObservations: 0,
  statusMismatches: [],
  materializationInvalid: 0,
  leakageDetected: 0,
  cleanupFailures: 0,
};
const failures = [];
let nextJob = 0;
await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

// --- derive every reported property from what was observed -------------------------------------

const unstable = [...fingerprints].filter(([, values]) => values.size !== 1);
const cwdDivergent = [...fingerprintsByCwd].filter(([, byCwd]) => new Set(byCwd.values()).size > 1);
const casesUnderBothCwds = [...fingerprintsByCwd].filter(([, byCwd]) => byCwd.size === 2).length;
const statefulCases = baseCases.filter((item) => STATEFUL_TASKS.has(item.taskId));
const statefulUnstable = statefulCases.filter((item) => fingerprints.get(item.key).size !== 1);
const concurrencyCases = baseCases.filter((item) => CONCURRENCY_TASKS.has(item.taskId));
const concurrencyUnstable = concurrencyCases.filter(
  (item) => fingerprints.get(item.key).size !== 1,
);

if (unstable.length > 0) {
  failures.push(
    ...unstable.map(([key, values]) => `${key}: ${values.size} distinct normalized outcomes`),
  );
}
if (cwdDivergent.length > 0) {
  failures.push(
    ...cwdDivergent.map(([key]) => `${key}: outcome differs by child working directory`),
  );
}
if ([...cwdCounts.values()].some((count) => count === 0)) {
  failures.push("both child working directories must be exercised");
}
if (workspaces.size !== observations.workspaceObservations) {
  failures.push(
    `workspace reuse: ${observations.workspaceObservations} executions produced ${workspaces.size} distinct workspaces`,
  );
}
failures.push(...observations.statusMismatches);

const report = {
  cases: baseCases.length,
  rounds,
  executions: jobs.length,
  concurrency,
  executionOrder: "INTERLEAVED_ROTATED_REVERSED",

  // Measured: identical normalized outcome across every execution of a case, where executions were
  // rotated and reversed between rounds and interleaved across workers.
  orderIndependence: {
    measurement:
      "distinct normalized outcomes per case across rotated, reversed, interleaved rounds",
    stableCases: baseCases.length - unstable.length,
    totalCases: baseCases.length,
    unstableCases: unstable.map(([key]) => key),
  },

  // Measured: outcomes partitioned by the child's working directory and compared.
  cwdIndependence: {
    measurement: "normalized outcome per case compared across both child working directories",
    childWorkingDirectories: Object.fromEntries(cwdCounts),
    casesExercisedUnderBothCwds: casesUnderBothCwds,
    divergentCases: cwdDivergent.map(([key]) => key),
  },

  // Measured: every execution materialized its own temporary workspace directory.
  workspaceIsolation: {
    measurement:
      "distinct temporary workspace directories observed versus executions that reported one",
    executionsReportingWorkspace: observations.workspaceObservations,
    distinctWorkspaces: workspaces.size,
    reused: observations.workspaceObservations - workspaces.size,
  },

  // Raw observation, deliberately not a pass/fail signal. Every execution spawns its own node
  // process, but operating systems recycle process ids, so id uniqueness is a lower bound on
  // distinct processes and repeats here mean recycling rather than reuse. The evidence that no
  // module cache is shared is statefulFixtureStability below, and the ABI test
  // "fresh processes isolate grader state" in evaluation/abi-tests/contract.test.mjs.
  processObservation: {
    measurement: "grader process ids observed; uniqueness is not asserted because ids are recycled",
    executionsReportingPid: observations.pidObservations,
    distinctProcessIds: graderPids.size,
    moduleCacheIsolationEvidence: "statefulFixtureStability",
  },

  // Measured on the cases that would actually expose a shared module cache or shared temporary
  // state: these fixtures accumulate module-level state, so a reused module cache or workspace
  // would make their outcomes drift between executions. Named explicitly so the basis is auditable.
  statefulFixtureStability: {
    measurement: "outcome stability restricted to fixtures holding module-level mutable state",
    tasks: [...STATEFUL_TASKS].toSorted(),
    cases: statefulCases.length,
    unstableCases: statefulUnstable.map((item) => item.key),
  },

  // Measured on the two tasks whose contract is concurrent access.
  synchronizationStability: {
    measurement: `outcome stability of concurrency-contract tasks across ${rounds} rounds at concurrency ${concurrency}`,
    tasks: [...CONCURRENCY_TASKS].toSorted(),
    cases: concurrencyCases.length,
    unstableCases: concurrencyUnstable.map((item) => item.key),
  },

  // Measured per execution from the runner's evidence. Leakage detection is lexical: see
  // evaluation/lib/leakage.mjs.
  perExecutionEvidence: {
    executions: observations.executions,
    materializationInvalid: observations.materializationInvalid,
    lexicalLeakageDetected: observations.leakageDetected,
    cleanupFailures: observations.cleanupFailures,
  },

  // Not measured by this run. Stated rather than converted into a pass.
  notChecked: {
    semanticLeakage: "NOT_CHECKED",
    crossProcessFilesystemContention: "NOT_CHECKED",
    schedulerFairness: "NOT_CHECKED",
  },

  failures,
};

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exitCode = 1;

async function runWorker() {
  while (true) {
    const index = nextJob;
    nextJob += 1;
    if (index >= jobs.length) return;
    const job = jobs[index];
    const childCwd = index % 2 === 0 ? repositoryRoot : evaluationRoot;
    cwdCounts.set(childCwd, cwdCounts.get(childCwd) + 1);
    const curatorRoot = path.join(evaluationRoot, "curator", job.phase);
    const result = await runCase({
      taskId: job.taskId,
      candidate: job.candidate,
      publicRepo: path.join(evaluationRoot, "fixtures", job.phase, job.taskId, "public", "repo"),
      grader: path.join(curatorRoot, job.taskId, "grader.mjs"),
      overlayData: job.overlayData,
      childCwd,
    });

    observations.executions += 1;
    if (result.status !== job.expected) {
      observations.statusMismatches.push(
        `${job.key} round ${job.round}: expected ${job.expected}, got ${result.status} (${result.message})`,
      );
    }
    if (result.evidence.materialization !== "VALID") observations.materializationInvalid += 1;
    if (result.evidence.leakage !== "PASS") observations.leakageDetected += 1;
    if (result.evidence.cleanup !== "PASS") observations.cleanupFailures += 1;
    if (result.workspace) {
      observations.workspaceObservations += 1;
      workspaces.add(result.workspace);
    }
    if (result.graderPid !== null && result.graderPid !== undefined) {
      observations.pidObservations += 1;
      graderPids.add(result.graderPid);
    }

    const fingerprint = normalize(result);
    fingerprints.get(job.key).add(fingerprint);
    const byCwd = fingerprintsByCwd.get(job.key);
    if (byCwd.has(childCwd) && byCwd.get(childCwd) !== fingerprint) {
      byCwd.set(`${childCwd}#divergent-${byCwd.size}`, fingerprint);
    } else {
      byCwd.set(childCwd, fingerprint);
    }
  }
}

async function loadOverlays(phase) {
  const files = ["overlays.json"];
  if (phase === "phase-c") files.push("overlays-band3.json");
  files.push("overlays-hardening.json");
  const merged = {};
  for (const file of files) {
    const document = await readJson(path.join(evaluationRoot, "curator", phase, file));
    for (const [candidate, tasks] of Object.entries(document)) {
      merged[candidate] = { ...merged[candidate], ...tasks };
    }
  }
  return merged;
}

function normalize(result) {
  return JSON.stringify({
    status: result.status,
    checks: result.checks,
    message: result.message,
    evidence: { ...result.evidence, cleanup: undefined },
  }).replaceAll(/maf-curator-[A-Za-z0-9_-]+/g, "maf-curator-<workspace>");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
