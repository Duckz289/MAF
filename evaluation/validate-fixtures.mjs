import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(evaluationRoot, "fixtures");
const phaseB = JSON.parse(
  await readFile(path.join(evaluationRoot, "phase-b", "manifest.json"), "utf8"),
);
const phaseC = JSON.parse(
  await readFile(path.join(evaluationRoot, "phase-c", "manifest.json"), "utf8"),
);
const expected = [
  ...phaseB.tasks.map(([id]) => ["phase-b", id]),
  ...Object.values(phaseC.bands)
    .flat()
    .map((id) => ["phase-c", id]),
];
const forbiddenPath = /(?:hidden|grader|reference|shortcut|curator|salvage|private)/i;
const forbiddenContent =
  /(?:hidden grader|expected patch|correct owner|superseded by|unused by any live|retained only for historical reference|b3-config-provider-boundary-trace|b3-dead-code-vs-live-discount-path|b3-decoy-cache-source-of-truth|b3-duplicate-service-owner|b3-event-handler-owner-trace)/i;
const failures = [];
const measured = { filesScanned: 0, pathFindings: 0, contentFindings: 0, nulByteFindings: 0 };
for (const [phase, id] of expected) {
  const root = path.join(fixtureRoot, phase, id);
  const publicRoot = path.join(root, "public");
  try {
    const info = await stat(publicRoot);
    if (!info.isDirectory()) failures.push(`${phase}/${id}: public is not a directory`);
  } catch {
    failures.push(`${phase}/${id}: missing public materialization`);
    continue;
  }
  const entries = await readdir(publicRoot, { recursive: true });
  for (const entry of entries) {
    if (forbiddenPath.test(entry)) {
      measured.pathFindings += 1;
      failures.push(`${phase}/${id}: forbidden public path ${entry}`);
    }
    const file = path.join(publicRoot, entry);
    try {
      const data = await readFile(file);
      measured.filesScanned += 1;
      if (data.includes(0)) {
        measured.nulByteFindings += 1;
        failures.push(`${phase}/${id}: NUL byte in ${entry}`);
      }
      if (forbiddenContent.test(data.toString("utf8"))) {
        measured.contentFindings += 1;
        failures.push(`${phase}/${id}: forbidden public content in ${entry}`);
      }
    } catch {
      // Recursive directory entries are returned on some Node versions.
    }
  }
}
if (failures.length) throw new Error(failures.join("\n"));
// Every field below is a measured count or an explicit NOT_CHECKED. The previous version printed
// hiddenIsolation, leakage and deterministicPolicy as the literal string "PASS" regardless of what
// the scan found, and deterministicPolicy was never measured here at all.
console.log(
  JSON.stringify({
    measurement: "lexical scan of every materialized public fixture file",
    tasks: expected.length,
    publicMaterializations: expected.length,
    filesScanned: measured.filesScanned,
    forbiddenPathFindings: measured.pathFindings,
    forbiddenContentFindings: measured.contentFindings,
    nulByteFindings: measured.nulByteFindings,
    notChecked: {
      // Determinism is measured by run-determinism-stress.mjs, not by a static fixture scan.
      deterministicPolicy: "NOT_CHECKED",
      // Semantic leakage is out of scope; see evaluation/lib/leakage.mjs.
      semanticLeakage: "NOT_CHECKED",
    },
  }),
);
