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
if (baseCases.length !== 145) throw new Error(`expected 145 cases, found ${baseCases.length}`);
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
const cwdCounts = new Map([
  [repositoryRoot, 0],
  [evaluationRoot, 0],
]);
const failures = [];
let completed = 0;
let nextJob = 0;
await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

for (const [key, values] of fingerprints) {
  if (values.size !== 1) failures.push(`${key}: ${values.size} distinct normalized outcomes`);
}
if ([...cwdCounts.values()].some((count) => count === 0)) {
  failures.push("both child working directories must be exercised");
}
if (failures.length > 0) throw new Error(failures.join("\n"));
console.log(
  JSON.stringify({
    cases: baseCases.length,
    rounds,
    executions: jobs.length,
    concurrency,
    executionOrder: "INTERLEAVED_ROTATED_REVERSED",
    childWorkingDirectories: Object.fromEntries(cwdCounts),
    stableOutcomes: baseCases.length,
    staleModuleCache: "PASS",
    sharedTempState: "PASS",
    orderIndependence: "PASS",
    cwdIndependence: "PASS",
    deterministicSynchronization: "PASS",
    filenameLeakage: "PASS",
    contentLeakage: "PASS",
    materialization: "PASS",
    hiddenIsolation: "PASS",
  }),
);

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
    if (result.status !== job.expected) {
      failures.push(
        `${job.key} round ${job.round}: expected ${job.expected}, got ${result.status}`,
      );
    }
    if (result.evidence.materialization !== "VALID") {
      failures.push(`${job.key} round ${job.round}: materialization invalid`);
    }
    if (result.evidence.leakage !== "PASS") {
      failures.push(`${job.key} round ${job.round}: leakage detected`);
    }
    fingerprints.get(job.key).add(normalize(result));
    completed += 1;
    if (completed % baseCases.length === 0) {
      console.log(JSON.stringify({ progress: completed, total: jobs.length }));
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
    evidence: result.evidence,
  }).replaceAll(/maf-curator-[A-Za-z0-9_-]+/g, "maf-curator-<workspace>");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
