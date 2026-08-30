import { spawn } from "node:child_process";
import { cp, lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VALID_STATUSES = new Set(["PASS", "FAIL", "INVALID"]);
const PRIVATE_PATH_PATTERN =
  /(?:^|[\\/._-])(grader|reference|wrong|alternative|attack|curator|solution|private)(?:$|[\\/._-])/i;
const PRIVATE_CONTENT_PATTERN =
  /\b(?:hidden grader|reference implementation|curator notes?|private artifact|expected solution)\b/i;

export async function runCase({
  taskId,
  candidate = "pristine",
  publicRepo,
  grader,
  overlay,
  tempRoot = os.tmpdir(),
  timeoutMs = 10_000,
  childCwd,
}) {
  const evidence = { materialization: "INVALID", leakage: "INVALID", grader: "NOT_RUN" };
  let workspace;
  try {
    if (!(await isDirectory(publicRepo))) {
      return invalidResult(taskId, candidate, evidence, "public repository is missing");
    }
    workspace = await mkdtemp(path.join(tempRoot, "maf-curator-"));
    await cp(publicRepo, workspace, { recursive: true, errorOnExist: true });
    if (overlay) await applyOverlay(overlay, workspace);
    evidence.materialization = "VALID";
    const leaks = await findPrivateLeakage(workspace);
    if (leaks.length > 0) {
      evidence.leakage = "FAIL";
      return invalidResult(taskId, candidate, evidence, `private leakage: ${leaks.join(", ")}`);
    }
    evidence.leakage = "PASS";
    const graderResult = await invokeGrader({ grader, workspace, timeoutMs, childCwd });
    evidence.grader = graderResult.status === "INVALID" ? "INVALID" : "VALID";
    return {
      taskId,
      candidate,
      status: graderResult.status,
      checks: graderResult.checks,
      message: graderResult.message,
      evidence,
    };
  } catch (error) {
    return invalidResult(taskId, candidate, evidence, errorMessage(error));
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
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
  if (!overlay || Array.isArray(overlay) || typeof overlay !== "object") {
    throw new Error("overlay must be a JSON object");
  }
  const workspaceRoot = path.resolve(workspace);
  for (const [relativePath, content] of Object.entries(overlay)) {
    if (typeof content !== "string")
      throw new Error(`overlay content must be text: ${relativePath}`);
    if (path.isAbsolute(relativePath))
      throw new Error(`overlay path must be relative: ${relativePath}`);
    const target = path.resolve(workspaceRoot, relativePath);
    if (target === workspaceRoot || !target.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error(`overlay path escapes workspace: ${relativePath}`);
    }
    const parent = path.dirname(target);
    if (!(await isDirectory(parent)))
      throw new Error(`overlay parent does not exist: ${relativePath}`);
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink())
      throw new Error(`overlay target is a symbolic link: ${relativePath}`);
    await writeFile(target, content, { encoding: "utf8", flag: "w" });
  }
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
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(invalidGraderResult("grader timed out"));
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
      resolve(result);
    }
  });
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

export async function findPrivateLeakage(workspace) {
  const leaks = [];
  for (const entry of await readdir(workspace, { recursive: true })) {
    const relative = String(entry);
    if (PRIVATE_PATH_PATTERN.test(relative)) leaks.push(`path:${relative}`);
    const absolute = path.join(workspace, relative);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile() || info.size > 1_000_000) continue;
    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content && PRIVATE_CONTENT_PATTERN.test(content)) leaks.push(`content:${relative}`);
  }
  return leaks;
}

function normalizeResult(result) {
  return JSON.stringify({
    status: result.status,
    checks: result.checks,
    message: result.message,
    evidence: result.evidence,
  });
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
