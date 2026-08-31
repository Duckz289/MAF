// Fail-closed ABI regression tests for the independent-audit repair.
//
// M1: a grader timeout could surface as a thrown EBUSY from workspace cleanup instead of an
//     INVALID classification, aborting the whole matrix. Reproduced in three forms: a plain hang,
//     a hang with a live descendant holding the workspace working directory, and a grader that
//     completes while leaking a descendant.
// M2: overlay containment validated only the final resolved target, so a reparse point at an
//     intermediate component redirected the write outside the workspace. Windows drive-relative
//     paths ("C:foo") were also accepted and left to path.resolve.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  applyOverlayData,
  removeWorkspace,
  resolveContainedTarget,
  runCase,
} from "../lib/curator-runner.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

// --- M1: grader failure modes must always classify ---------------------------------------------

test("a hanging grader is INVALID and does not throw", async () => {
  const { repo, grader } = await scenario("hang", "setTimeout(() => {}, 60_000);\n");
  const result = await runCase({ taskId: "hang", publicRepo: repo, grader, timeoutMs: 700 });
  assert.equal(result.status, "INVALID");
  assert.equal(result.evidence.grader, "INVALID");
  assert.match(result.message, /timed out/);
});

test("a grader timing out with a live descendant is INVALID and does not throw", async () => {
  const { repo, grader } = await scenario(
    "descendant",
    `import { spawn } from "node:child_process";
const index = process.argv.indexOf("--workspace");
spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
  cwd: process.argv[index + 1],
  detached: true,
  stdio: "ignore",
});
setTimeout(() => {}, 60_000);
`,
  );
  const result = await runCase({ taskId: "descendant", publicRepo: repo, grader, timeoutMs: 700 });
  assert.equal(result.status, "INVALID");
  assert.match(result.message, /timed out/);
});

test("a completed grader keeps its classification even when it leaks a descendant", async () => {
  // The descendant is unref'd so the grader itself exits promptly; it then holds the workspace
  // working directory open while cleanup runs. The PASS must survive whatever cleanup reports.
  const { repo, grader } = await scenario(
    "leaky",
    `import { spawn } from "node:child_process";
const index = process.argv.indexOf("--workspace");
const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 4000)"], {
  cwd: process.argv[index + 1],
  detached: true,
  stdio: "ignore",
});
child.unref();
console.log(JSON.stringify({
  status: "PASS",
  checks: [{ name: "ran", passed: true, message: "ok" }],
  message: "ok",
}));
`,
  );
  const result = await runCase({ taskId: "leaky", publicRepo: repo, grader, timeoutMs: 5_000 });
  assert.equal(
    result.status,
    "PASS",
    `cleanup must not erase the classification: ${result.message}`,
  );
  assert.equal(result.evidence.grader, "VALID");
  assert.ok(
    result.evidence.cleanup === "PASS" || result.evidence.cleanup.startsWith("FAILED:"),
    `cleanup evidence must be reported, got ${result.evidence.cleanup}`,
  );
});

test("a grader that writes to stderr and exits non-zero is INVALID", async () => {
  const { repo, grader } = await scenario(
    "crash",
    `process.stderr.write("boom\\n");\nprocess.exit(3);\n`,
  );
  const result = await runCase({ taskId: "crash", publicRepo: repo, grader, timeoutMs: 5_000 });
  assert.equal(result.status, "INVALID");
  assert.equal(result.evidence.grader, "INVALID");
});

test("every runCase reports cleanup evidence", async () => {
  const { repo, grader } = await scenario(
    "clean",
    `console.log(JSON.stringify({ status: "FAIL", checks: [{ name: "n", passed: false, message: "m" }], message: "m" }));\n`,
  );
  const result = await runCase({ taskId: "clean", publicRepo: repo, grader, timeoutMs: 5_000 });
  assert.equal(result.status, "FAIL");
  assert.equal(result.evidence.cleanup, "PASS");
});

test("workspace removal never throws and always returns evidence", async () => {
  assert.equal(await removeWorkspace(path.join(os.tmpdir(), "maf-does-not-exist-probe")), "PASS");
  const root = await track(await mkdtemp(path.join(os.tmpdir(), "maf-cleanup-")));
  assert.equal(await removeWorkspace(root), "PASS");
  // A path whose parent is a regular file cannot be removed as a directory tree; the contract is
  // that this is reported, not raised.
  const file = await track(await mkdtemp(path.join(os.tmpdir(), "maf-cleanup-file-")));
  await writeFile(path.join(file, "regular"), "x", "utf8");
  const outcome = await removeWorkspace(path.join(file, "regular", "nested"));
  assert.equal(typeof outcome, "string");
});

// --- M2: overlay containment ------------------------------------------------------------------

test("an intermediate directory link cannot be written through", async () => {
  const base = await track(await mkdtemp(path.join(os.tmpdir(), "maf-link-")));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "victim.txt"), "ORIGINAL", "utf8");
  if (!(await link(path.join(workspace, "src", "linked"), outside))) return;

  await assert.rejects(
    () => applyOverlayData({ "src/linked/victim.txt": "PWNED" }, workspace),
    /escapes workspace/,
  );
  assert.equal(await readFile(path.join(outside, "victim.txt"), "utf8"), "ORIGINAL");
});

test("a deeper intermediate link cannot be written through either", async () => {
  const base = await track(await mkdtemp(path.join(os.tmpdir(), "maf-link-deep-")));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(path.join(workspace, "a", "b"), { recursive: true });
  await mkdir(path.join(outside, "c"), { recursive: true });
  await writeFile(path.join(outside, "c", "victim.txt"), "ORIGINAL", "utf8");
  if (!(await link(path.join(workspace, "a", "b", "linked"), outside))) return;

  await assert.rejects(
    () => applyOverlayData({ "a/b/linked/c/victim.txt": "PWNED" }, workspace),
    /escapes workspace/,
  );
  assert.equal(await readFile(path.join(outside, "c", "victim.txt"), "utf8"), "ORIGINAL");
});

test("a linked overlay target itself is rejected", async () => {
  const base = await track(await mkdtemp(path.join(os.tmpdir(), "maf-link-file-")));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "victim.txt"), "ORIGINAL", "utf8");
  if (
    !(await link(
      path.join(workspace, "src", "victim.txt"),
      path.join(outside, "victim.txt"),
      "file",
    ))
  ) {
    return;
  }
  await assert.rejects(() => applyOverlayData({ "src/victim.txt": "PWNED" }, workspace), /link/);
  assert.equal(await readFile(path.join(outside, "victim.txt"), "utf8"), "ORIGINAL");
});

test("drive-relative overlay paths are rejected explicitly", async () => {
  const workspace = await track(await mkdtemp(path.join(os.tmpdir(), "maf-drive-")));
  await assert.rejects(() => applyOverlayData({ "C:evil.txt": "x" }, workspace), /drive-relative/);
  await assert.rejects(
    () => applyOverlayData({ "z:payload.mjs": "x" }, workspace),
    /drive-relative/,
  );
});

test("traversal and absolute overlay paths stay rejected", async () => {
  const workspace = await track(await mkdtemp(path.join(os.tmpdir(), "maf-traversal-")));
  await mkdir(path.join(workspace, "sub"), { recursive: true });
  for (const bad of ["../escape.mjs", "sub/../../escape.mjs", "a/b/../../../escape.mjs", ".."]) {
    await assert.rejects(
      () => applyOverlayData({ [bad]: "x" }, workspace),
      /escapes workspace/,
      bad,
    );
  }
  await assert.rejects(
    () => applyOverlayData({ [path.join(workspace, "abs.mjs")]: "x" }, workspace),
    /must be relative/,
  );
  await assert.rejects(() => applyOverlayData({ "": "x" }, workspace), /non-empty string/);
});

test("contained overlay paths with dot segments are still accepted", async () => {
  const workspace = await track(await mkdtemp(path.join(os.tmpdir(), "maf-contained-")));
  await mkdir(path.join(workspace, "sub"), { recursive: true });
  await applyOverlayData({ "sub/./../sub/file.mjs": "export const ok = true;\n" }, workspace);
  assert.match(await readFile(path.join(workspace, "sub", "file.mjs"), "utf8"), /ok = true/);
});

test("resolveContainedTarget returns the canonical target for contained paths", async () => {
  const workspace = await track(await mkdtemp(path.join(os.tmpdir(), "maf-resolve-")));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  const target = await resolveContainedTarget(await realpathOf(workspace), "src/x.mjs");
  assert.ok(target.endsWith(path.join("src", "x.mjs")));
});

// --- helpers ------------------------------------------------------------------------------------

async function track(root) {
  roots.push(root);
  return root;
}

async function realpathOf(target) {
  const { realpath } = await import("node:fs/promises");
  return await realpath(target);
}

// Creates a directory junction (Windows) or symlink (POSIX). Returns false when the platform
// refuses, so the test degrades to a no-op instead of a spurious failure.
async function link(linkPath, target, type = "junction") {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch {
    if (process.platform !== "win32" || type === "file") return false;
    try {
      execFileSync("cmd", ["/c", "mklink", "/J", linkPath, target], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

async function scenario(name, graderBody) {
  const base = await track(await mkdtemp(path.join(os.tmpdir(), `maf-abi-${name}-`)));
  const repo = path.join(base, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "seed.mjs"), "export const seed = true;\n", "utf8");
  const grader = path.join(base, "grader-script.mjs");
  await writeFile(grader, graderBody, "utf8");
  return { base, repo, grader };
}
