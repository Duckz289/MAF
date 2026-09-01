import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRepeatedCase } from "./lib/curator-runner.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const pilots = [
  { id: "clamp-number-util", phase: "phase-b", repeats: 2 },
  { id: "b2-partial-validation-mutation", phase: "phase-c", repeats: 3 },
];
const candidates = ["pristine", "reference", "wrong", "alternative"];
const matrix = [];

for (const pilot of pilots) {
  for (const candidate of candidates) {
    const privateRoot = path.join(root, "abi-pilots", pilot.id);
    const result = await runRepeatedCase(
      {
        taskId: pilot.id,
        candidate,
        publicRepo: path.join(root, "fixtures", pilot.phase, pilot.id, "public", "repo"),
        grader: path.join(privateRoot, "grader", "grader.mjs"),
        overlay:
          candidate === "pristine" ? undefined : path.join(privateRoot, candidate, "overlay.json"),
      },
      pilot.repeats,
    );
    matrix.push({
      taskId: pilot.id,
      candidate,
      status: result.status,
      deterministic: result.deterministic,
      materializationValid: result.results.every(
        (item) => item.evidence.materialization === "VALID",
      ),
      hiddenIsolated: result.results.every((item) => item.evidence.leakage === "PASS"),
    });
  }
}

const expected = { pristine: "FAIL", reference: "PASS", wrong: "FAIL", alternative: "PASS" };
const failures = matrix.filter(
  (item) =>
    item.status !== expected[item.candidate] ||
    !item.deterministic ||
    !item.materializationValid ||
    !item.hiddenIsolated,
);
console.log(
  JSON.stringify(
    { contract: "NEWLY_AUTHORED_RECONSTRUCTION", matrix, failures: failures.length },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
