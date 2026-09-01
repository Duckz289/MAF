// Missing-artifact fail-closed tests.
//
// M8: a missing wrong or attack overlay was silently treated as pristine. The unmodified fixture
// ran, the grader failed it, and the row satisfied its expected FAIL -- so the matrix reported
// coverage for a candidate that did not exist.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildCuratorMatrix, loadOverlays, matrixFailures } from "../lib/curator-matrix.mjs";

const evaluationRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TASK = "clamp-number-util";

const phaseBOverlays = async (mutate = () => {}) => {
  const overlays = await loadOverlays(path.join(evaluationRoot, "curator", "phase-b"), "phase-b");
  mutate(overlays);
  return { "phase-b": overlays };
};

const rowFor = (matrix, candidate) =>
  matrix.find((item) => item.taskId === TASK && item.candidate === candidate);

test("a present wrong candidate grades normally", async () => {
  const matrix = await buildCuratorMatrix({
    evaluationRoot,
    phases: ["phase-b"],
    candidates: ["wrong"],
    overlaysByPhase: await phaseBOverlays(),
  });
  const row = rowFor(matrix, "wrong");
  assert.equal(row.artifact, "PRESENT");
  assert.equal(row.status, "FAIL");
  assert.equal(matrixFailures(matrix).length, 0);
});

test("a missing wrong candidate is INVALID, not a silent pristine run", async () => {
  const matrix = await buildCuratorMatrix({
    evaluationRoot,
    phases: ["phase-b"],
    candidates: ["wrong"],
    overlaysByPhase: await phaseBOverlays((overlays) => {
      delete overlays.wrong[TASK];
    }),
  });
  const row = rowFor(matrix, "wrong");
  assert.equal(row.artifact, "MISSING");
  assert.equal(row.status, "INVALID");
  assert.match(row.message, /required wrong candidate artifact is missing/);
  assert.ok(
    matrixFailures(matrix).some((item) => item.taskId === TASK),
    "a missing required artifact must be a matrix failure",
  );
});

test("a missing attack candidate is INVALID too", async () => {
  const matrix = await buildCuratorMatrix({
    evaluationRoot,
    phases: ["phase-b"],
    candidates: ["attack"],
    overlaysByPhase: await phaseBOverlays((overlays) => {
      delete overlays.attack[TASK];
    }),
  });
  assert.equal(rowFor(matrix, "attack").artifact, "MISSING");
  assert.equal(rowFor(matrix, "attack").status, "INVALID");
});

test("a missing reference candidate cannot satisfy its expected PASS", async () => {
  const matrix = await buildCuratorMatrix({
    evaluationRoot,
    phases: ["phase-b"],
    candidates: ["reference"],
    overlaysByPhase: await phaseBOverlays((overlays) => {
      delete overlays.reference[TASK];
    }),
  });
  const row = rowFor(matrix, "reference");
  assert.equal(row.status, "INVALID");
  assert.notEqual(row.status, row.expected);
});

test("missing artifacts are excluded from the run only by an explicit opt-in", async () => {
  const overlaysByPhase = await phaseBOverlays((overlays) => {
    delete overlays.wrong[TASK];
  });
  const skipped = await buildCuratorMatrix({
    evaluationRoot,
    phases: ["phase-b"],
    candidates: ["wrong"],
    skipMissing: true,
    overlaysByPhase,
  });
  assert.equal(rowFor(skipped, "wrong"), undefined, "the case is dropped, never faked");
  assert.equal(matrixFailures(skipped).length, 0);

  const notSkipped = await buildCuratorMatrix({
    evaluationRoot,
    phases: ["phase-b"],
    candidates: ["wrong"],
    skipMissing: false,
    overlaysByPhase,
  });
  assert.equal(rowFor(notSkipped, "wrong").artifact, "MISSING");
});

test("a missing artifact never produces the same row as a real candidate", async () => {
  const present = await buildCuratorMatrix({
    evaluationRoot,
    phases: ["phase-b"],
    candidates: ["wrong"],
    overlaysByPhase: await phaseBOverlays(),
  });
  const absent = await buildCuratorMatrix({
    evaluationRoot,
    phases: ["phase-b"],
    candidates: ["wrong"],
    overlaysByPhase: await phaseBOverlays((overlays) => {
      delete overlays.wrong[TASK];
    }),
  });
  const presentRow = rowFor(present, "wrong");
  const absentRow = rowFor(absent, "wrong");
  assert.notEqual(presentRow.status, absentRow.status);
  assert.notEqual(presentRow.artifact, absentRow.artifact);
});
