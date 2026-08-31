// Independent-audit regression harness for snapshot bb3265275cd1291e84807c7c453d9bec72229884.
//
// This runner is deliberately independent of the curator matrix. It materializes each stored
// candidate against the public fixture, invokes the hidden grader, and compares the observed status
// with the status the *public contract* requires. It exists so that the defects reported by the
// independent audit stay reproducible after they are repaired, and so that a grader cannot be
// declared valid merely because the curator's own overlays agree with it.
//
// See evaluation/regression/README.md for the corpus layout.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCase } from "./lib/curator-runner.mjs";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const regressionRoot = path.join(evaluationRoot, "regression");
const selected = argument("--corpus", "all");

const index = JSON.parse(await readFile(path.join(regressionRoot, "index.json"), "utf8"));
const cases = index.cases.filter((entry) => selected === "all" || entry.corpus === selected);
if (cases.length === 0) throw new Error(`no regression cases selected for corpus ${selected}`);

const rows = [];
for (const entry of cases) {
  const expected = index.corpora[entry.corpus]?.expectedStatus;
  if (!expected) throw new Error(`${entry.id}: unknown corpus ${entry.corpus}`);
  const overlay = await readCandidate(path.join(regressionRoot, "candidates", entry.corpus, entry.id));
  if (Object.keys(overlay).length === 0) {
    throw new Error(`${entry.corpus}/${entry.id}: candidate directory is empty or missing`);
  }
  const result = await runCase({
    taskId: entry.taskId,
    candidate: `${entry.corpus}/${entry.id}`,
    publicRepo: path.join(evaluationRoot, "fixtures", entry.phase, entry.taskId, "public", "repo"),
    grader: path.join(evaluationRoot, "curator", entry.phase, entry.taskId, "grader.mjs"),
    overlayData: overlay,
  });
  rows.push({
    corpus: entry.corpus,
    id: entry.id,
    taskId: entry.taskId,
    files: Object.keys(overlay).length,
    expected,
    status: result.status,
    correct: result.status === expected,
    clause: entry.violation ?? entry.satisfies ?? null,
    failedChecks: (result.checks ?? []).filter((check) => !check.passed).map((check) => check.name),
    message: result.message,
  });
}

const byCorpus = {};
for (const row of rows) {
  byCorpus[row.corpus] ??= { cases: 0, correct: 0, incorrect: [] };
  byCorpus[row.corpus].cases += 1;
  if (row.correct) byCorpus[row.corpus].correct += 1;
  else byCorpus[row.corpus].incorrect.push(row.id);
}
const incorrect = rows.filter((row) => !row.correct);
console.log(JSON.stringify({ cases: rows.length, incorrect: incorrect.length, byCorpus, rows }, null, 2));
if (incorrect.length > 0) process.exitCode = 1;

// Recursively collect a candidate directory into an overlay map keyed by repo-relative POSIX paths.
async function readCandidate(root) {
  const overlay = {};
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => null);
  if (entries === null) return overlay;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    overlay[relative] = await readFile(absolute, "utf8");
  }
  return overlay;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
