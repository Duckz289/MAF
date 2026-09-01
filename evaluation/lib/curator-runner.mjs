import { spawn, spawnSync } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findPrivateLeakage } from "./leakage.mjs";

const VALID_STATUSES = new Set(["PASS", "FAIL", "INVALID"]);

// Windows drive-relative paths ("C:foo") are neither absolute nor safely relative: they resolve
// against the current directory *of that drive*, which is process state the runner does not own.
// The candidate ABI does not support them, so they are rejected rather than left to path.resolve.
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

const CLEANUP_RETRIES = 8;
const CLEANUP_RETRY_DELAY_MS = 75;
const TERMINATION_GRACE_MS = 400;

export async function runCase({
  taskId,
  candidate = "pristine",
  publicRepo,
  grader,
  overlay,
  overlayData,
  tempRoot = os.tmpdir(),
  timeoutMs = 10_000,
  childCwd,
}) {
  const evidence = {
    materialization: "INVALID",
    leakage: "INVALID",
    grader: "NOT_RUN",
    cleanup: "NOT_RUN",
  };
  let workspace;
  let result;
  try {
    if (!(await isDirectory(publicRepo))) {
      result = invalidResult(taskId, candidate, evidence, "public repository is missing");
      return result;
    }
    workspace = await mkdtemp(path.join(tempRoot, "maf-curator-"));
    await cp(publicRepo, workspace, { recursive: true, errorOnExist: true });
    if (overlay && overlayData) throw new Error("provide either overlay or overlayData, not both");
    if (overlay) await applyOverlay(overlay, workspace);
    if (overlayData) await applyOverlayData(overlayData, workspace);
    evidence.materialization = "VALID";
    const leaks = await findPrivateLeakage(workspace, { taskId });
    if (leaks.length > 0) {
      evidence.leakage = "FAIL";
      result = invalidResult(taskId, candidate, evidence, `private leakage: ${leaks.join(", ")}`);
      return result;
    }
    evidence.leakage = "PASS";
    const graderResult = await invokeGrader({ grader, workspace, timeoutMs, childCwd });
    evidence.grader = graderResult.status === "INVALID" ? "INVALID" : "VALID";
    result = {
      taskId,
      candidate,
      status: graderResult.status,
      checks: graderResult.checks,
      message: graderResult.message,
      evidence,
      // Observations, not classification. They let a report measure workspace isolation and
      // process freshness rather than assert them. normalizeResult ignores them.
      workspace: path.basename(workspace),
      graderPid: graderResult.pid ?? null,
      childCwd: childCwd ? path.resolve(childCwd) : path.resolve(workspace),
    };
    return result;
  } catch (error) {
    result = invalidResult(taskId, candidate, evidence, errorMessage(error));
    return result;
  } finally {
    // Cleanup is bounded and never throws. A workspace that cannot be removed -- because a grader
    // descendant still holds its working directory, for instance -- is reported as evidence, never
    // as an exception, because an exception here would discard the classification that was already
    // determined. This is the fail-closed requirement: every case leaves with a PASS/FAIL/INVALID.
    if (workspace) evidence.cleanup = await removeWorkspace(workspace);
  }
}

export async function runRepeatedCase(options, repetitions = 2) {
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new TypeError("repetitions must be a positive integer");
  }
  const results = [];
  for (let index = 0; index < repetitions; index += 1) results.push(await runCase(options));
  return {
    taskId: options.taskId,
    candidate: options.candidate ?? "pristine",
    status: results[0].status,
    deterministic: new Set(results.map(normalizeResult)).size === 1,
    results,
  };
}

export async function applyOverlay(overlayPath, workspace) {
  if (!(await isDirectory(workspace))) throw new Error("candidate workspace is missing");
  const raw = await readFile(overlayPath, "utf8");
  let overlay;
  try {
    overlay = JSON.parse(raw);
  } catch {
    throw new Error("overlay is malformed JSON");
  }
  await applyOverlayData(overlay, workspace);
}

export async function applyOverlayData(overlay, workspace) {
  if (!(await isDirectory(workspace))) throw new Error("candidate workspace is missing");
  if (!overlay || Array.isArray(overlay) || typeof overlay !== "object") {
    throw new Error("overlay must be a JSON object");
  }
  // Canonicalise the root once. On Windows the temporary directory is frequently reached through a
  // short (8.3) path, so comparing an uncanonicalised root against a canonicalised target would
  // produce spurious escapes.
  const workspaceRoot = await realpath(path.resolve(workspace));
  for (const [relativePath, content] of Object.entries(overlay)) {
    if (typeof content !== "string") {
      throw new Error(`overlay content must be text: ${relativePath}`);
    }
    const target = await resolveContainedTarget(workspaceRoot, relativePath);
    const parent = path.dirname(target);
    if (!(await isDirectory(parent))) {
      throw new Error(`overlay parent does not exist: ${relativePath}`);
    }
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new Error(`overlay target is a symbolic link: ${relativePath}`);
    }
    await writeFile(target, content, { encoding: "utf8", flag: "w" });
  }
}

// Resolves an overlay path against the canonical workspace root and proves the write cannot leave
// it. Checking only the resolved string is not sufficient: a reparse point (symlink or directory
// junction) at any *intermediate* component redirects the write while the string still looks
// contained. Every existing component is inspected, and the deepest existing ancestor is
// canonicalised as an independent confirmation.
export async function resolveContainedTarget(workspaceRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error(`overlay path must be a non-empty string: ${String(relativePath)}`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`overlay path must be relative: ${relativePath}`);
  }
  if (DRIVE_RELATIVE.test(relativePath)) {
    throw new Error(`overlay path must not be drive-relative: ${relativePath}`);
  }
  const target = path.resolve(workspaceRoot, relativePath);
  if (target === workspaceRoot || !target.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`overlay path escapes workspace: ${relativePath}`);
  }

  const segments = path.relative(workspaceRoot, target).split(path.sep);
  let current = workspaceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new Error(`overlay path escapes workspace through a link: ${relativePath}`);
    }
  }

  const realParent = await realpath(path.dirname(target)).catch(() => null);
  if (
    realParent !== null &&
    realParent !== workspaceRoot &&
    !realParent.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error(`overlay path escapes workspace through a link: ${relativePath}`);
  }
  return target;
}

export async function invokeGrader({ grader, workspace, timeoutMs = 10_000, childCwd }) {
  if (!(await isDirectory(workspace))) return invalidGraderResult("candidate workspace is missing");
  if (!(await isFile(grader))) return invalidGraderResult("grader is missing");
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.resolve(grader), "--workspace", path.resolve(workspace)],
      {
        cwd: childCwd ? path.resolve(childCwd) : path.resolve(workspace),
        env: { ...process.env, MAF_CURATOR_PRIVATE_ROOT: undefined },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // A process group on POSIX makes the whole grader tree killable in one call. Windows uses
        // taskkill /T instead, which walks the tree from the live parent.
        detached: process.platform !== "win32",
      },
    );
    const pid = child.pid ?? null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let graceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      // Resolve once the child actually closes, so its handles on the workspace are released before
      // cleanup runs. The grace timer guarantees the case is still classified if it never closes.
      graceTimer = setTimeout(
        () => finish(invalidGraderResult("grader timed out")),
        TERMINATION_GRACE_MS,
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      finish(invalidGraderResult(`grader failed to start: ${errorMessage(error)}`)),
    );
    child.on("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        finish(invalidGraderResult("grader timed out"));
        return;
      }
      if (code !== 0) {
        finish(invalidGraderResult(`grader crashed (${signal ?? code}): ${stderr.trim()}`));
        return;
      }
      finish(parseGraderOutput(stdout));
    });
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({ ...result, pid });
    }
  });
}

// Terminates a grader and every process it started. A grader that leaks a descendant would
// otherwise keep the candidate workspace alive and, on Windows, hold its working directory open.
export function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // taskkill is unavailable; fall through to the direct kill below.
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone; fall through to the direct kill below.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

// Bounded, non-throwing workspace removal. Returns evidence rather than raising, so a cleanup
// failure can never overwrite a case's PASS/FAIL/INVALID classification.
export async function removeWorkspace(workspace) {
  try {
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: CLEANUP_RETRIES,
      retryDelay: CLEANUP_RETRY_DELAY_MS,
    });
    return "PASS";
  } catch (error) {
    return `FAILED: ${errorMessage(error)}`;
  }
}

export function parseGraderOutput(stdout) {
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return invalidGraderResult("grader emitted malformed JSON");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return invalidGraderResult("grader result must be an object");
  }
  if (!VALID_STATUSES.has(value.status))
    return invalidGraderResult("grader emitted an unknown status");
  if (typeof value.message !== "string" || !Array.isArray(value.checks)) {
    return invalidGraderResult("grader result is missing required fields");
  }
  const validChecks = value.checks.every(
    (check) =>
      check &&
      !Array.isArray(check) &&
      typeof check === "object" &&
      typeof check.name === "string" &&
      typeof check.passed === "boolean" &&
      typeof check.message === "string",
  );
  if (!validChecks) return invalidGraderResult("grader checks are malformed");
  if (
    value.status === "PASS" &&
    (value.checks.length === 0 || value.checks.some((check) => !check.passed))
  ) {
    return invalidGraderResult("PASS conflicts with grader checks");
  }
  return { status: value.status, checks: value.checks, message: value.message };
}

export { findPrivateLeakage } from "./leakage.mjs";

function normalizeResult(result) {
  return JSON.stringify({
    status: result.status,
    checks: result.checks,
    message: result.message,
    evidence: { ...result.evidence, cleanup: undefined },
  }).replaceAll(/maf-curator-[A-Za-z0-9_-]+/g, "maf-curator-<workspace>");
}
function invalidResult(taskId, candidate, evidence, message) {
  return { taskId, candidate, status: "INVALID", checks: [], message, evidence };
}
function invalidGraderResult(message) {
  return { status: "INVALID", checks: [], message };
}
async function isDirectory(target) {
  return (await stat(target).catch(() => null))?.isDirectory() ?? false;
}
async function isFile(target) {
  return (await stat(target).catch(() => null))?.isFile() ?? false;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
