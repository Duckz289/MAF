import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  candidateIntegrityFromArtifact,
  evidenceForStatus,
  notVerified,
  type CandidateArtifactEvidence,
  type IndependentVerificationInput,
  type IndependentVerificationResult,
  type IndependentVerifier,
  type VerificationStatus,
} from "./independent-verification";

// The real controller-side verifier.
//
// This is the implementation that puts the suite's actual hidden graders onto the production DVS
// path. It runs after a participant has finished, against a workspace the controller allocated and
// owns, and the participant never receives a handle to it.
//
// What it establishes, and how:
//
//   candidateIntegrity  by diffing the controller's workspace against the pristine public fixture
//                       the controller materialized, then checking containment and parseability.
//   hiddenGrader        by invoking the task's curator grader in a separate process. The grader
//                       lives outside the workspace and is never copied into it.
//   regression          by executing the fixture's own public entrypoint in the workspace and
//                       requiring it to complete cleanly.
//
// What it does NOT do, stated so no report overclaims it: the regression check is a smoke
// regression over the fixture's public entrypoint, not a full project test suite. A task with no
// entrypoint yields regression NOT_CHECKED, which blocks DVS rather than granting it.

export interface CuratorTaskLocation {
  /** "phase-b" or "phase-c". */
  phase: string;
  /** Task directory name under evaluation/fixtures/<phase>/ and evaluation/curator/<phase>/. */
  taskId: string;
}

export interface CuratorVerifierOptions {
  evaluationRoot: string;
  /** Maps a benchmark task id onto a curator task. Returning null means "no grader for this task". */
  locate: (taskId: string) => CuratorTaskLocation | null;
  graderTimeoutMs?: number;
  regressionTimeoutMs?: number;
}

const DEFAULT_GRADER_TIMEOUT_MS = 30_000;
const DEFAULT_REGRESSION_TIMEOUT_MS = 20_000;

interface CuratorRunnerModule {
  invokeGrader(input: {
    grader: string;
    workspace: string;
    timeoutMs?: number;
  }): Promise<{ status: string; message: string }>;
}

export class CuratorIndependentVerifier implements IndependentVerifier {
  constructor(private readonly options: CuratorVerifierOptions) {}

  async verify(input: IndependentVerificationInput): Promise<IndependentVerificationResult> {
    const location = this.options.locate(input.taskId);
    if (!location) return notVerified(`no curator task is registered for ${input.taskId}`);
    if (!input.workspacePath) {
      return notVerified(`no controller-owned workspace was allocated for ${input.taskId}`);
    }

    const pristineRepo = path.join(
      this.options.evaluationRoot,
      "fixtures",
      location.phase,
      location.taskId,
      "public",
      "repo",
    );
    const graderPath = path.join(
      this.options.evaluationRoot,
      "curator",
      location.phase,
      location.taskId,
      "grader.mjs",
    );

    const notes: string[] = [];
    const artifact = await observeArtifact(input.workspacePath, pristineRepo);
    const integrity = candidateIntegrityFromArtifact(artifact);
    notes.push(...integrity.notes);

    // A candidate that is missing or structurally invalid is not graded: there is nothing to grade,
    // and running a grader over it would only produce a verdict about the fixture.
    let graderStatus: VerificationStatus = "NOT_RUN";
    let regressionStatus: VerificationStatus = "NOT_RUN";
    if (integrity.candidateIntegrity === "VALID") {
      graderStatus = await this.runHiddenGrader(graderPath, input.workspacePath, notes);
      regressionStatus = await this.runRegression(input.workspacePath, notes);
    } else {
      notes.push("the hidden grader was not run because the candidate artifact is not valid");
    }

    return {
      source: "INDEPENDENT",
      candidateIntegrity: integrity.candidateIntegrity,
      candidateExists: integrity.candidateExists,
      hiddenGrader: evidenceForStatus(graderStatus),
      regression: evidenceForStatus(regressionStatus),
      graderStatus,
      regressionStatus,
      artifact,
      notes,
    };
  }

  private async runHiddenGrader(
    graderPath: string,
    workspace: string,
    notes: string[],
  ): Promise<VerificationStatus> {
    if (!(await isFile(graderPath))) {
      notes.push(`hidden grader is missing at ${graderPath}`);
      return "NOT_RUN";
    }
    const runnerUrl = pathToFileURL(
      path.join(this.options.evaluationRoot, "lib", "curator-runner.mjs"),
    ).href;
    const runner = (await import(/* @vite-ignore */ runnerUrl)) as unknown as CuratorRunnerModule;
    const result = await runner.invokeGrader({
      grader: graderPath,
      workspace,
      timeoutMs: this.options.graderTimeoutMs ?? DEFAULT_GRADER_TIMEOUT_MS,
    });
    notes.push(`hidden grader: ${result.message}`);
    if (result.status === "PASS") return "PASS";
    if (result.status === "FAIL") return "FAIL";
    return "INVALID";
  }

  /**
   * Deterministic regression check, run by the controller and independent of both the participant
   * and the hidden grader.
   *
   * Two things must hold. Every module the candidate ships must still load -- a candidate that
   * breaks an import, a top-level initialiser or the module graph is a regression whatever the
   * grader concluded. And every public entrypoint the fixture ships must still run to a clean exit.
   *
   * A workspace with neither modules nor entrypoints yields NOT_RUN, which blocks a DVS rather than
   * granting one. The driver is written outside the workspace so the candidate artifact is not
   * altered by being verified.
   */
  private async runRegression(workspace: string, notes: string[]): Promise<VerificationStatus> {
    const modules = (await listFiles(path.join(workspace, "src"))).filter((file) =>
      file.endsWith(".mjs"),
    );
    const entrypoints = (await listFiles(path.join(workspace, "bin"))).filter((file) =>
      file.endsWith(".mjs"),
    );
    if (modules.length === 0 && entrypoints.length === 0) {
      notes.push("no modules or entrypoints to run a regression check against");
      return "NOT_RUN";
    }

    const timeoutMs = this.options.regressionTimeoutMs ?? DEFAULT_REGRESSION_TIMEOUT_MS;
    const driverRoot = await mkdtemp(path.join(os.tmpdir(), "maf-regression-"));
    try {
      const driver = path.join(driverRoot, "regression-driver.mjs");
      const targets = [...modules, ...entrypoints].map((file) => pathToFileURL(file).href);
      await writeFile(
        driver,
        `for (const target of ${JSON.stringify(targets)}) {
  await import(target);
}
`,
        "utf8",
      );
      const outcome = await runNode(driver, workspace, timeoutMs);
      notes.push(
        outcome.status === "PASS"
          ? `regression: ${modules.length} module(s) and ${entrypoints.length} entrypoint(s) loaded and ran cleanly`
          : `regression failed: ${outcome.detail}`,
      );
      return outcome.status;
    } finally {
      await rm(driverRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }
}

/**
 * Observes the candidate artifact from the controller's side. The participant's claims about what
 * it changed play no part: the change set is computed by comparing the controller's workspace with
 * the pristine fixture the controller materialized it from.
 */
export const observeArtifact = async (
  workspace: string,
  pristineRepo: string,
): Promise<CandidateArtifactEvidence> => {
  if (!(await isDirectory(workspace))) {
    return {
      workspaceExists: false,
      containedInWorkspace: true,
      observedChangedFiles: [],
      structurallyValid: false,
      quarantined: false,
    };
  }
  const workspaceRoot = path.resolve(workspace);
  const [candidateFiles, baselineFiles] = await Promise.all([
    readTree(workspaceRoot),
    readTree(path.resolve(pristineRepo)).catch(() => new Map<string, string>()),
  ]);

  const observedChangedFiles: string[] = [];
  for (const [relative, content] of candidateFiles) {
    if (baselineFiles.get(relative) !== content) observedChangedFiles.push(relative);
  }
  for (const relative of baselineFiles.keys()) {
    if (!candidateFiles.has(relative)) observedChangedFiles.push(relative);
  }
  observedChangedFiles.sort();

  const containedInWorkspace = observedChangedFiles.every((relative) => {
    const resolved = path.resolve(workspaceRoot, relative);
    return resolved.startsWith(`${workspaceRoot}${path.sep}`);
  });
  const structurallyValid = await parsesCleanly(workspaceRoot, observedChangedFiles);

  return {
    workspaceExists: true,
    containedInWorkspace,
    observedChangedFiles,
    structurallyValid,
    quarantined: false,
  };
};

/**
 * Structural validity of the candidate's own changes, checked with Node's parser rather than by
 * executing anything. Only the files the controller observed as changed are checked: a fixture that
 * already parses is not the candidate's responsibility.
 */
const parsesCleanly = async (root: string, changedFiles: string[]): Promise<boolean> => {
  const modules = changedFiles.filter(
    (relative) => relative.endsWith(".mjs") || relative.endsWith(".js"),
  );
  for (const relative of modules) {
    const absolute = path.join(root, relative);
    if (!(await isFile(absolute))) continue;
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(process.execPath, ["--check", absolute], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (!ok) return false;
  }
  return true;
};

const readTree = async (root: string): Promise<Map<string, string>> => {
  const files = new Map<string, string>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    files.set(relative, await readFile(absolute, "utf8"));
  }
  return files;
};

/** Runs a script under Node and classifies the outcome. Never throws. */
const runNode = async (
  script: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ status: VerificationStatus; detail: string }> =>
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const finish = (status: VerificationStatus, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, detail });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish("INVALID", "timed out");
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish("INVALID", `could not start: ${error.message}`));
    child.on("close", (code) =>
      finish(code === 0 ? "PASS" : "FAIL", `exited ${code}: ${stderr.trim().slice(0, 300)}`),
    );
  });

/** Absolute paths of every file under `root`, or an empty list when it does not exist. */
const listFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
};

const isDirectory = async (target: string): Promise<boolean> =>
  (await stat(target).catch(() => null))?.isDirectory() ?? false;
const isFile = async (target: string): Promise<boolean> =>
  (await stat(target).catch(() => null))?.isFile() ?? false;
