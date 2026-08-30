import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pilots = [
  { id: "clamp-number-util", phase: "phase-b", repeats: 2, probe: "import { roundTo, isInRange } from './src/number-utils.mjs'; console.log(JSON.stringify([roundTo(1.234,2),roundTo(9.99,0),isInRange(0,1,3),isInRange(2,1,3)]));", grade: (r) => r.exitCode === 0 && r.stdout.trim() === "[1.23,10,false,true]" ? "PASS" : "FAIL" },
  { id: "b2-partial-validation-mutation", phase: "phase-c", repeats: 3, probe: "import { applyPatch } from './src/apply-patch.mjs'; const record={status:'open',owner:'Ada'}; let rejected=false; try{applyPatch(record,{status:'invalid'});}catch{rejected=true;} console.log(JSON.stringify({rejected,unchanged:record.status==='open'&&record.owner==='Ada'}));", grade: (r) => r.exitCode === 0 && r.stdout.includes('"rejected":true') && r.stdout.includes('"unchanged":true') ? "PASS" : "FAIL" },
];
const candidates = ["pristine", "reference", "wrong", "alternative"];
const matrix = [];
for (const pilot of pilots) for (const candidate of candidates) {
  const statuses = [];
  for (let i = 0; i < pilot.repeats; i++) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "maf-abi-"));
    try {
      await cp(path.join(root, "fixtures", pilot.phase, pilot.id, "public", "repo"), workspace, { recursive: true });
      const visible = await readdir(workspace, { recursive: true });
      if (visible.some((x) => /grader|reference|wrong|alternative|curator|solution/i.test(x))) throw new Error("private leakage");
      if (candidate !== "pristine") await apply(path.join(root, "abi-pilots", pilot.id, candidate, "overlay.json"), workspace);
      await writeFile(path.join(workspace, "abi-probe.mjs"), pilot.probe);
      statuses.push(pilot.grade(await execute(path.join(workspace, "abi-probe.mjs"), workspace)));
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }
  const expected = { pristine: "PASS", reference: "PASS", wrong: "FAIL", alternative: "PASS" };
  const row = { taskId: pilot.id, candidate, statuses, expected: expected[candidate], deterministic: new Set(statuses).size === 1, materialization: true, hiddenIsolated: true };
  if (statuses.some((x) => x !== row.expected)) throw new Error(`${pilot.id}/${candidate}: ${statuses} expected ${row.expected}`);
  matrix.push(row);
}
console.log(JSON.stringify({ contract: "NEWLY_AUTHORED_RECONSTRUCTION", matrix }, null, 2));
async function apply(file, workspace) { const overlay = JSON.parse(await readFile(file, "utf8")); for (const [name, contents] of Object.entries(overlay)) await writeFile(path.join(workspace, name), contents, "utf8"); }
function execute(file, cwd) { return new Promise((resolve) => { const p = spawn(process.execPath, [file], { cwd }); let stdout = "", stderr = ""; p.stdout.on("data", (x) => stdout += x); p.stderr.on("data", (x) => stderr += x); p.on("close", (exitCode) => resolve({ exitCode, stdout, stderr })); }); }
