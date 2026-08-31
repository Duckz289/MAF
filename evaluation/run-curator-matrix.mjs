// Curator matrix CLI. The matrix itself lives in evaluation/lib/curator-matrix.mjs so that its
// fail-closed behavior on missing candidate artifacts can be tested directly.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCuratorMatrix, matrixFailures } from "./lib/curator-matrix.mjs";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const phase = argument("--phase", "all");
const band = argument("--band", "all");
const repetitions = Number(argument("--repetitions", "1"));
const skipMissing = argument("--skip-missing", "false") === "true";
const candidates = argument("--candidates", "pristine,reference,wrong,alternative").split(",");

const matrix = await buildCuratorMatrix({
  evaluationRoot,
  phases: phase === "all" ? ["phase-b", "phase-c"] : [phase],
  band,
  candidates,
  repetitions,
  skipMissing,
});
const failures = matrixFailures(matrix);
const missingArtifacts = matrix.filter((item) => item.artifact === "MISSING");
console.log(
  JSON.stringify(
    {
      repetitions,
      cases: matrix.length,
      failures: failures.length,
      missingArtifacts: missingArtifacts.length,
      skipMissing,
      matrix,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
