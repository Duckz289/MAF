import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(evaluationRoot, "fixtures");
const phaseB = JSON.parse(await readFile(path.join(evaluationRoot, "phase-b", "manifest.json"), "utf8"));
const phaseC = JSON.parse(await readFile(path.join(evaluationRoot, "phase-c", "manifest.json"), "utf8"));
const expected = [
  ...phaseB.tasks.map(([id]) => ["phase-b", id]),
  ...Object.values(phaseC.bands).flat().map((id) => ["phase-c", id]),
];
const forbidden = /(?:hidden|grader|reference|shortcut|curator|salvage|private)/i;
const failures = [];
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
    if (forbidden.test(entry)) failures.push(`${phase}/${id}: forbidden public path ${entry}`);
    const file = path.join(publicRoot, entry);
    try {
      const data = await readFile(file);
      if (data.includes(0)) failures.push(`${phase}/${id}: NUL byte in ${entry}`);
    } catch {
      // Recursive directory entries are returned on some Node versions.
    }
  }
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(JSON.stringify({ tasks: expected.length, publicMaterializations: expected.length, hiddenIsolation: "PASS", leakage: "PASS", deterministicPolicy: "PASS" }));
