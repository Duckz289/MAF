// Curator matrix construction.
//
// The independent audit of snapshot bb326527 found (M8) that a missing wrong or attack overlay was
// silently treated as pristine: the case ran the unmodified fixture, the grader failed it, and the
// row satisfied its expected FAIL. Coverage was therefore inferred from an expected status rather
// than from a candidate that actually existed.
//
// A required candidate artifact that is absent is an explicit MISSING_ARTIFACT failure here.
// Skipping is only possible by opting in with skipMissing, which is for exploratory runs; it can
// never happen implicitly.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runRepeatedCase } from "./curator-runner.mjs";

export const EXPECTED_STATUS = {
  pristine: "FAIL",
  reference: "PASS",
  wrong: "FAIL",
  alternative: "PASS",
  attack: "FAIL",
  probe: "PASS",
};

export async function buildCuratorMatrix({
  evaluationRoot,
  phases = ["phase-b", "phase-c"],
  band = "all",
  candidates = ["pristine", "reference", "wrong", "alternative"],
  repetitions = 1,
  skipMissing = false,
  // Test seam: supply overlays directly instead of reading them from the curator directories.
  overlaysByPhase,
}) {
  const matrix = [];
  for (const phaseName of phases) {
    const curatorRoot = path.join(evaluationRoot, "curator", phaseName);
    const taskIds = await loadTaskIds(evaluationRoot, phaseName, band);
    const overlays = overlaysByPhase?.[phaseName] ?? (await loadOverlays(curatorRoot, phaseName));
    for (const taskId of taskIds) {
      for (const candidate of candidates) {
        const overlayData = candidate === "pristine" ? undefined : overlays[candidate]?.[taskId];

        // Fail closed. Without a candidate artifact there is nothing to grade, and running the
        // pristine fixture in its place would manufacture a passing row out of a missing one.
        if (candidate !== "pristine" && overlayData === undefined) {
          if (skipMissing) continue;
          matrix.push({
            phase: phaseName,
            taskId,
            candidate,
            status: "INVALID",
            expected: EXPECTED_STATUS[candidate],
            deterministic: true,
            materializationValid: false,
            hiddenIsolated: false,
            artifact: "MISSING",
            message: `required ${candidate} candidate artifact is missing for ${taskId}`,
            checks: [],
          });
          continue;
        }

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
          expected: EXPECTED_STATUS[candidate],
          deterministic: result.deterministic,
          materializationValid: result.results.every(
            (item) => item.evidence.materialization === "VALID",
          ),
          hiddenIsolated: result.results.every((item) => item.evidence.leakage === "PASS"),
          artifact: candidate === "pristine" ? "NOT_REQUIRED" : "PRESENT",
          cleanup: result.results.every((item) => item.evidence.cleanup === "PASS")
            ? "PASS"
            : "FAILED",
          message: result.results[0].message,
          checks: result.results[0].checks,
        });
      }
    }
  }
  return matrix;
}

export function matrixFailures(matrix) {
  return matrix.filter(
    (item) =>
      !item.expected ||
      item.artifact === "MISSING" ||
      item.status !== item.expected ||
      !item.deterministic ||
      !item.materializationValid ||
      !item.hiddenIsolated,
  );
}

export async function loadOverlays(curatorRoot, phaseName) {
  const files = ["overlays.json"];
  if (phaseName === "phase-c") files.push("overlays-band3.json");
  files.push("overlays-hardening.json");
  const merged = {};
  for (const file of files) {
    const document = JSON.parse(await readFile(path.join(curatorRoot, file), "utf8"));
    for (const [candidate, tasks] of Object.entries(document)) {
      merged[candidate] = { ...merged[candidate], ...tasks };
    }
  }
  return merged;
}

export async function loadTaskIds(evaluationRoot, phaseName, selectedBand) {
  const manifest = JSON.parse(
    await readFile(path.join(evaluationRoot, phaseName, "manifest.json"), "utf8"),
  );
  if (phaseName === "phase-b") return manifest.tasks.map(([id]) => id);
  if (selectedBand === "all") return Object.values(manifest.bands).flat();
  return selectedBand.split(",").flatMap((name) => manifest.bands[name] ?? []);
}
