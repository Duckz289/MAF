import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  applyOverlay,
  findPrivateLeakage,
  invokeGrader,
  parseGraderOutput,
  runCase,
  runRepeatedCase,
} from "../lib/curator-runner.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("missing candidate workspace is INVALID", async () => {
  const result = await invokeGrader({ grader: "missing.mjs", workspace: "missing-workspace" });
  assert.equal(result.status, "INVALID");
});
test("missing grader is INVALID", async () => {
  const root = await fixture();
  assert.equal(
    (await invokeGrader({ grader: path.join(root, "missing.mjs"), workspace: root })).status,
    "INVALID",
  );
});
test("grader crash is INVALID", async () => {
  const root = await fixture();
  const grader = await script(root, "throw new Error('boom')");
  assert.equal((await invokeGrader({ grader, workspace: root })).status, "INVALID");
});
test("malformed JSON is INVALID", () =>
  assert.equal(parseGraderOutput("not-json").status, "INVALID"));
test("unknown status is INVALID", () => {
  assert.equal(
    parseGraderOutput('{"status":"UNKNOWN","checks":[],"message":"x"}').status,
    "INVALID",
  );
});
test("missing result fields are INVALID", () =>
  assert.equal(parseGraderOutput('{"status":"PASS"}').status, "INVALID"));
test("malformed checks are INVALID", () => {
  assert.equal(
    parseGraderOutput('{"status":"FAIL","checks":[{"name":"x"}],"message":"x"}').status,
    "INVALID",
  );
});
test("PASS with a failed check is INVALID", () => {
  const output =
    '{"status":"PASS","checks":[{"name":"x","passed":false,"message":"x"}],"message":"x"}';
  assert.equal(parseGraderOutput(output).status, "INVALID");
});
test("failed overlay is INVALID", async () => {
  const root = await fixture();
  const overlay = path.join(root, "overlay.json");
  await writeFile(overlay, '{"../escape.mjs":"bad"}');
  await assert.rejects(() => applyOverlay(overlay, root), /escapes workspace/);
});
test("malformed overlay is INVALID", async () => {
  const root = await fixture();
  const overlay = path.join(root, "overlay.json");
  await writeFile(overlay, "{");
  await assert.rejects(() => applyOverlay(overlay, root), /malformed JSON/);
});
test("materialization failure is INVALID", async () => {
  const result = await runCase({ taskId: "missing", publicRepo: "missing", grader: "missing" });
  assert.equal(result.status, "INVALID");
  assert.equal(result.evidence.materialization, "INVALID");
});
test("private filename leakage is detected", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "reference-solution.mjs"), "export default true");
  assert.match((await findPrivateLeakage(root)).join(" "), /path:/);
});
test("private content leakage is detected", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "ordinary.mjs"), "// curator note: expected solution follows");
  assert.match((await findPrivateLeakage(root)).join(" "), /content:/);
});
test("grader error cannot become PASS", async () => {
  const root = await fixture();
  const grader = await script(
    root,
    "console.log(JSON.stringify({status:'UNKNOWN',checks:[],message:'x'}))",
  );
  assert.equal((await invokeGrader({ grader, workspace: root })).status, "INVALID");
});
test("fresh processes isolate grader state", async () => {
  const root = await fixture();
  const grader = await script(
    root,
    "globalThis.count=(globalThis.count??0)+1; console.log(JSON.stringify({status:globalThis.count===1?'PASS':'FAIL',checks:[{name:'fresh',passed:globalThis.count===1,message:String(globalThis.count)}],message:'fresh'}))",
  );
  const result = await runRepeatedCase({ taskId: "isolation", publicRepo: root, grader }, 3);
  assert.equal(result.status, "PASS");
  assert.equal(result.deterministic, true);
});
test("grader invocation is independent of caller cwd", async () => {
  const root = await fixture();
  const elsewhere = await fixture();
  const grader = await script(
    root,
    "console.log(JSON.stringify({status:'PASS',checks:[{name:'cwd',passed:true,message:process.cwd()}],message:'ok'}))",
  );
  assert.equal(
    (await invokeGrader({ grader, workspace: root, childCwd: elsewhere })).status,
    "PASS",
  );
});
test("well-formed FAIL remains FAIL", () => {
  const output =
    '{"status":"FAIL","checks":[{"name":"x","passed":false,"message":"no"}],"message":"failed"}';
  assert.equal(parseGraderOutput(output).status, "FAIL");
});
test("well-formed PASS remains PASS", () => {
  const output =
    '{"status":"PASS","checks":[{"name":"x","passed":true,"message":"yes"}],"message":"passed"}';
  assert.equal(parseGraderOutput(output).status, "PASS");
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "maf-abi-test-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "seed.mjs"), "export const seed = true;\n");
  return root;
}
async function script(root, content) {
  const grader = path.join(root, `case-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(grader, `${content}\n`);
  return grader;
}
