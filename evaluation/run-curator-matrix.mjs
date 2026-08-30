import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRepeatedCase } from "./lib/curator-runner.mjs";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const phase = argument("--phase", "all");
const repetitions = Number(argument("--repetitions", "1"));
const requestedCandidates = argument("--candidates", "pristine,reference,wrong,alternative").split(
  ",",
);
const phases = phase === "all" ? ["phase-b", "phase-c"] : [phase];
const expectedStatus = {
  pristine: "FAIL",
  reference: "PASS",
  wrong: "FAIL",
  alternative: "PASS",
  attack: "FAIL",
};
const matrix = [];

for (const phaseName of phases) {
  const taskIds = await loadTaskIds(phaseName);
  const curatorRoot = path.join(evaluationRoot, "curator", phaseName);
  const overlays = JSON.parse(await readFile(path.join(curatorRoot, "overlays.json"), "utf8"));
  for (const taskId of taskIds) {
    for (const candidate of requestedCandidates) {
      const overlayData = candidate === "pristine" ? undefined : overlays[candidate]?.[taskId];
      const result = await runRepeatedCase(
        {
          taskId,
          candidate,
          publicRepo: path.join(evaluationRoot, "fixtures", phaseName, taskId, "public", "repo"),
          grader: path.join(curatorRoot, taskId, "grader.mjs"),
          overlayData,
        },
        repetitions,
      );
      matrix.push({
        phase: phaseName,
        taskId,
        candidate,
        status: result.status,
        expected: expectedStatus[candidate],
        deterministic: result.deterministic,
        materializationValid: result.results.every(
          (item) => item.evidence.materialization === "VALID",
        ),
        hiddenIsolated: result.results.every((item) => item.evidence.leakage === "PASS"),
        message: result.results[0].message,
        checks: result.results[0].checks,
      });
    }
  }
}

const failures = matrix.filter(
  (item) =>
    !item.expected ||
    item.status !== item.expected ||
    !item.deterministic ||
    !item.materializationValid ||
    !item.hiddenIsolated,
);
console.log(
  JSON.stringify({ repetitions, cases: matrix.length, failures: failures.length, matrix }, null, 2),
);
if (failures.length > 0) process.exitCode = 1;

async function loadTaskIds(phaseName) {
  const manifest = JSON.parse(
    await readFile(path.join(evaluationRoot, phaseName, "manifest.json"), "utf8"),
  );
  if (phaseName === "phase-b") return manifest.tasks.map(([id]) => id);
  return Object.values(manifest.bands).flat();
}
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
