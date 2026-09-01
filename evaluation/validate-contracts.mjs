import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPrivateLeakage } from "./lib/leakage.mjs";

// Leakage detection is delegated to evaluation/lib/leakage.mjs rather than re-implemented here.
// This script used to carry its own regex, which matched "solution" inside "resolution-policy" and
// "reference" inside any word containing it -- the same substring flaw the orientation analyzer had.
// One tokenizing detector, used everywhere, is both stricter and less prone to false positives.
const root = path.dirname(fileURLToPath(import.meta.url));
const meta = JSON.parse(await readFile(path.join(root, "contracts", "tasks.json"), "utf8"));
const failures = [];
let filesScanned = 0;
for (const task of meta) {
  const pub = path.join(root, "fixtures", task.phase, task.id, "public");
  try {
    if (!(await stat(path.join(pub, "prompt.md")).catch(() => null)))
      failures.push(`${task.id}: prompt`);
    const files = await readdir(pub, { recursive: true });
    if (!files.some((x) => x.endsWith(".mjs"))) failures.push(`${task.id}: source`);
    for (const leak of await findPrivateLeakage(pub, { taskId: task.id })) {
      failures.push(`${task.id}: ${leak}`);
    }
    for (const f of files) {
      const b = await readFile(path.join(pub, f)).catch(() => null);
      if (b) filesScanned += 1;
      if (b?.includes(0)) failures.push(`${task.id}: NUL byte in ${f}`);
    }
  } catch (e) {
    failures.push(`${task.id}: ${e.message}`);
  }
}
if (failures.length) throw new Error(failures.join("\n"));
// Measured counts only. `status: "PASS"` was previously printed unconditionally after the checks
// above; the checks throw on any finding, so what this script can honestly report is what it
// scanned and what it found.
console.log(
  JSON.stringify({
    measurement:
      "every declared task has a public prompt and sources, and no public file carries a private filename or phrase",
    label: "NEWLY_AUTHORED_RECONSTRUCTION",
    tasksChecked: meta.length,
    filesScanned,
    findings: failures.length,
    phaseB: meta.filter((x) => x.phase === "phase-b").length,
    phaseC: meta.filter((x) => x.phase === "phase-c").length,
  }),
);
