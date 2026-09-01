// Band 3 orientation audit.
//
// This script MEASURES the Band 3 fixtures. It does not read a stored classification and echo it
// back, and it does not print any literal "PASS". Every number in its output is computed from the
// repository on disk by evaluation/lib/orientation.mjs, and the classification is derived from
// those numbers by the declared thresholds.
//
// The stored band3-context-audit.json supplies only the two facts a static analysis cannot infer:
// which module is the entrypoint and which module owns the defect. Everything else it declares --
// decoys in particular -- is treated as a claim to be checked, not as evidence.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeOrientation, THRESHOLDS } from "./lib/orientation.mjs";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const writeReport = process.argv.includes("--write-report");
const requireStrong = process.argv.includes("--require-strong");

const manifest = JSON.parse(
  await readFile(path.join(evaluationRoot, "phase-c", "manifest.json"), "utf8"),
);
const declared = JSON.parse(
  await readFile(
    path.join(evaluationRoot, "curator", "phase-c", "band3-context-audit.json"),
    "utf8",
  ),
);

const failures = [];
if (declared.map(({ id }) => id).join("\n") !== manifest.bands.band3.join("\n")) {
  failures.push("context audit tasks must exactly match the Band 3 manifest order");
}

const tasks = [];
for (const item of declared) {
  const publicRoot = path.join(evaluationRoot, "fixtures", "phase-c", item.id, "public");
  const repoRoot = path.join(publicRoot, "repo");
  const prompt = await readFile(path.join(publicRoot, "prompt.md"), "utf8");
  const analysis = await analyzeOrientation({
    repoRoot,
    entrypoint: item.entrypoint,
    defectOwner: item.defectOwner,
    decoys: item.decoys ?? [],
    prompt,
    symptomTerms: item.symptomTerms ?? [],
  });

  // The prompt must not name the owner module or its basename. This is measured against the file
  // that actually owns the defect, not against a list of historical identifiers.
  const ownerName = path.basename(item.defectOwner, ".mjs");
  if (prompt.includes(item.defectOwner) || prompt.includes(ownerName)) {
    failures.push(`${item.id}: prompt names the defect owner`);
  }
  for (const missing of analysis.evidence.decoys.filter((entry) => !entry.exists)) {
    failures.push(`${item.id}: declared decoy does not exist: ${missing.module}`);
  }
  if (!analysis.evidence.ownerReachable) {
    failures.push(`${item.id}: the declared defect owner is not reachable from the entrypoint`);
  }

  tasks.push({ id: item.id, ...analysis });
}

const counts = { CONTEXT_TEST_STRONG: 0, CONTEXT_TEST_WEAK: 0, NOT_A_CONTEXT_TEST: 0 };
for (const task of tasks) counts[task.classification] += 1;

if (requireStrong) {
  for (const task of tasks) {
    if (task.classification !== "CONTEXT_TEST_STRONG") {
      failures.push(
        `${task.id}: measured ${task.classification} -- ${[...task.disqualifying, ...task.weakening].join("; ")}`,
      );
    }
  }
}
// A NOT_A_CONTEXT_TEST fixture is always a hard failure: the manifest declares that such a task must
// be redesigned before frontier use.
for (const task of tasks) {
  if (task.classification === "NOT_A_CONTEXT_TEST") {
    failures.push(`${task.id}: NOT_A_CONTEXT_TEST -- ${task.disqualifying.join("; ")}`);
  }
}

const report = {
  measuredBy: "evaluation/lib/orientation.mjs",
  measurementBasis:
    "static ESM import graph of the public repository, walked from a search-aware landing point " +
    "(the file a realistic, precise search from the public prompt's own vocabulary would actually " +
    "reach), falling back to the entrypoint only when no such search exists",
  thresholds: THRESHOLDS,
  classificationCounts: counts,
  minimumInvestigationDepth: Math.min(
    ...tasks.map((task) => task.evidence.investigation.investigationDepth),
  ),
  minimumDecisionPoints: Math.min(
    ...tasks.map((task) => task.evidence.investigation.decisionPoints),
  ),
  tasksWithACollapsingSearch: tasks.filter(
    (task) => task.evidence.search.collapsingSearches.length > 0,
  ).length,
  anyEntrypointImportsOwner: tasks.some((task) => task.evidence.importGraph.entrypointImportsOwner),
  tasks: tasks.map((task) => ({
    id: task.id,
    classification: task.classification,
    disqualifying: task.disqualifying,
    weakening: task.weakening,
    evidence: task.evidence,
  })),
  failures,
};

if (writeReport) {
  await writeFile(
    path.join(evaluationRoot, "curator", "phase-c", "band3-orientation-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exitCode = 1;
