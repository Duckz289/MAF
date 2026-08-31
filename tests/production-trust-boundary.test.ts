import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  BenchmarkRunner,
  type BenchmarkExecution,
  type BenchmarkExecutor,
  type BenchmarkTask,
} from "../src/benchmark/runner";
import { CuratorIndependentVerifier } from "../src/evaluation/curator-verifier";
import {
  notVerified,
  type IndependentVerificationResult,
  type IndependentVerifier,
} from "../src/evaluation/independent-verification";

// Production trust boundary.
//
// The second independent audit found that the production DVS path derived hiddenGrader, regression
// and candidateIntegrity from the participant's own execution report, so a participant that
// returned `verificationResult: "VERIFIED"` with a fabricated `filesChanged` array minted a Durable
// Verified Success with no independent evidence in existence.
//
// Every test here runs through the real BenchmarkRunner.compare path. The proposition under test is
// a single one: participant self-report is not verification.

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evaluationRoot = path.join(repoRoot, "evaluation");
const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

/** A participant that asserts success no matter what it did. */
const lyingExecution = (overrides: Partial<BenchmarkExecution> = {}): BenchmarkExecution => ({
  agent: "lying-agent",
  model: "fixture-model",
  provider: "fixture",
  initialMode: "NATIVE",
  finalMode: "NATIVE",
  modeTransitions: [],
  signalSnapshots: [],
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  reportedCost: 0.01,
  latencyMs: 5,
  retryCount: 0,
  verificationAttempts: 1,
  repairAttempts: 0,
  verifierFailures: 0,
  verificationResult: "VERIFIED",
  // Fabricated: no such file was ever written.
  filesChanged: ["src/this-file-was-never-written.mjs"],
  modulesTouched: ["src"],
  contextExpansion: 1,
  orchestrationOverheadMs: 1,
  ...overrides,
});

const task: BenchmarkTask = {
  id: "trust-boundary-task",
  prompt: "Fix the fixture",
  expectedVerification: "npm test",
};

const stubVerifier = (result: Partial<IndependentVerificationResult>): IndependentVerifier => ({
  async verify() {
    return {
      source: "INDEPENDENT",
      candidateIntegrity: "VALID",
      candidateExists: true,
      hiddenGrader: "PASS",
      regression: "PASS",
      graderStatus: "PASS",
      regressionStatus: "PASS",
      notes: [],
      ...result,
    };
  },
});

const compareWith = async (
  verifier: IndependentVerifier | undefined,
  nativeExecution: BenchmarkExecution = lyingExecution(),
  mafExecution: BenchmarkExecution = lyingExecution(),
  benchmarkTask: BenchmarkTask = task,
) => {
  const executors: BenchmarkExecutor[] = [
    { strategy: "NATIVE", execute: async () => nativeExecution },
    { strategy: "MAF_ADAPTIVE", execute: async () => mafExecution },
  ];
  return await new BenchmarkRunner().compare(
    benchmarkTask,
    executors,
    verifier ? { verifier } : {},
  );
};

describe("participant self-report cannot mint a durable verified success", () => {
  // Case 1
  it("rejects a lying participant whose candidate the independent grader fails", async () => {
    const report = await compareWith(stubVerifier({ hiddenGrader: "FAIL", graderStatus: "FAIL" }));
    expect(report.evaluation.dvs).toBe(0);
    const native = report.evaluation.paired[0]?.native;
    expect(native?.hiddenGrader).toBe("FAIL");
    // The claim survives as diagnostics, and is visibly a claim.
    expect(native?.selfReported?.verificationResult).toBe("VERIFIED");
    expect(native?.selfReported?.claimedChangedFiles).toEqual([
      "src/this-file-was-never-written.mjs",
    ]);
    expect(native?.falseSafe).toBe(true);
  });

  // Case 2
  it("rejects a lying participant when the hidden grader returns INVALID", async () => {
    const report = await compareWith(
      stubVerifier({ hiddenGrader: "UNKNOWN", graderStatus: "INVALID" }),
    );
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.paired[0]?.native.hiddenGrader).toBe("UNKNOWN");
  });

  // Case 3
  it("rejects a lying participant when regression verification did not run", async () => {
    const report = await compareWith(
      stubVerifier({ regression: "NOT_CHECKED", regressionStatus: "NOT_RUN" }),
    );
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.paired[0]?.native.regression).toBe("NOT_CHECKED");
  });

  // Case 4
  it("rejects a lying participant when candidate integrity is invalid", async () => {
    const report = await compareWith(stubVerifier({ candidateIntegrity: "INVALID" }));
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.paired[0]?.native.candidateIntegrity).toBe("INVALID");
  });

  // Case 7
  it("rejects every run when no independent verifier is configured at all", async () => {
    const report = await compareWith(undefined);
    expect(report.evaluation.dvs).toBe(0);
    const native = report.evaluation.paired[0]?.native;
    expect(native?.evidenceSource).toBe("NOT_CHECKED");
    expect(native?.hiddenGrader).toBe("NOT_CHECKED");
    expect(native?.regression).toBe("NOT_CHECKED");
    expect(native?.candidateIntegrity).toBe("UNKNOWN");
  });

  it("rejects a run whose verifier declined to produce evidence", async () => {
    const declining: IndependentVerifier = {
      async verify() {
        return notVerified("declined");
      },
    };
    const report = await compareWith(declining);
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.paired[0]?.native.evidenceSource).toBe("NOT_CHECKED");
  });

  // Case 6
  it("accepts a run whose independent evidence is complete", async () => {
    const report = await compareWith(stubVerifier({}));
    expect(report.evaluation.dvs).toBe(2);
    expect(report.evaluation.paired[0]?.outcome).toBe("BOTH_PASS");
    expect(report.evaluation.paired[0]?.native.evidenceSource).toBe("INDEPENDENT");
  });

  // Case 5: deterministic evidence wins over the participant's own pessimism, too.
  it("accepts a run the participant declared failed when independent evidence passes", async () => {
    const modest = lyingExecution({
      verificationResult: "FAILED",
      filesChanged: [],
      modulesTouched: [],
    });
    const report = await compareWith(stubVerifier({}), modest, modest);
    expect(report.evaluation.dvs).toBe(2);
    const native = report.evaluation.paired[0]?.native;
    expect(native?.claimedDone).toBe(false);
    expect(native?.selfReported?.verificationResult).toBe("FAILED");
    expect(native?.candidateExists).toBe(true);
  });

  it("keeps infrastructure failure ahead of any evidence", async () => {
    const report = await compareWith(
      stubVerifier({}),
      lyingExecution({ executionStatus: "TIMEOUT" }),
      lyingExecution({ providerError: "429 rate limited" }),
    );
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.paired[0]?.outcome).toBe("INVALID_BOTH");
    expect(report.evaluation.paired[0]?.native.evidenceSource).toBe("NOT_CHECKED");
  });

  it("marks a run incoherent if evidence claims PASS without an independent source", async () => {
    const forged: IndependentVerifier = {
      async verify() {
        // A verifier that forgets to declare its source must not be able to grant a pass.
        return {
          source: "NOT_CHECKED",
          candidateIntegrity: "VALID",
          candidateExists: true,
          hiddenGrader: "PASS",
          regression: "PASS",
          graderStatus: "PASS",
          regressionStatus: "PASS",
          notes: [],
        };
      },
    };
    const report = await compareWith(forged);
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.runsWithCoherenceIssues).toBe(2);
    expect(report.evaluation.paired[0]?.native.coherenceIssues.join(" ")).toMatch(
      /independent verifier/,
    );
  });
});

describe("the trust boundary is structural, not incidental", () => {
  // A static guard so the defect cannot reappear by someone reaching for a convenient sample field.
  it("never derives a trusted field from a participant-reported one", async () => {
    const bridge = await readFile(
      path.join(repoRoot, "src", "evaluation", "benchmark-bridge.ts"),
      "utf8",
    );
    const body = bridge.slice(bridge.indexOf("export const evaluationRunFromSample"));
    const trustedFields = [
      "candidateExists",
      "candidateIntegrity",
      "evidenceSource",
      "hiddenGrader",
      "regression",
    ];
    const offenders: string[] = [];
    let seenAssignments = 0;
    for (const line of body.split("\n").map((entry) => entry.trim())) {
      const field = trustedFields.find(
        (name) => line.startsWith(`${name}:`) || line.startsWith(`const ${name} `),
      );
      if (!field) continue;
      seenAssignments += 1;
      if (line.includes("sample.")) offenders.push(line);
    }
    expect(offenders).toEqual([]);
    // The guard must be able to see the assignments at all, not vacuously pass on an empty scan.
    expect(seenAssignments).toBeGreaterThanOrEqual(trustedFields.length);
  });

  it("keeps participant claims confined to the self-report envelope", async () => {
    const bridge = await readFile(
      path.join(repoRoot, "src", "evaluation", "benchmark-bridge.ts"),
      "utf8",
    );
    const body = bridge.slice(bridge.indexOf("export const evaluationRunFromSample"));
    // The participant's verification claim may appear only inside selfReported and claimedDone.
    const uses = [
      ...body.matchAll(
        /^\s*([A-Za-z]+):.*sample\.(?:verificationResult|verifierFailures|filesChanged)/gm,
      ),
    ].map((match) => match[1]);
    expect(new Set(uses)).toEqual(
      new Set(["verificationResult", "claimedChangedFiles", "verifierFailures", "claimedDone"]),
    );
  });
});

describe("the real curator verifier on the production path", () => {
  const materialize = async (taskId: string, phase: string) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maf-trust-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    await cp(path.join(evaluationRoot, "fixtures", phase, taskId, "public", "repo"), workspace, {
      recursive: true,
    });
    return workspace;
  };

  const verifierFor = (taskId: string, phase: string) =>
    new CuratorIndependentVerifier({
      evaluationRoot,
      locate: () => ({ phase, taskId }),
    });

  it("fails a fabricated participant claim over an untouched workspace", async () => {
    const workspace = await materialize("clamp-number-util", "phase-b");
    const report = await compareWith(
      verifierFor("clamp-number-util", "phase-b"),
      lyingExecution(),
      lyingExecution(),
      { ...task, candidateWorkspaces: { NATIVE: workspace, MAF_ADAPTIVE: workspace } },
    );
    expect(report.evaluation.dvs).toBe(0);
    const native = report.evaluation.paired[0]?.native;
    // The controller saw no change at all, whatever the participant claimed to have written.
    expect(native?.candidateExists).toBe(false);
    expect(native?.candidateIntegrity).toBe("MISSING");
    expect(native?.selfReported?.claimedChangedFiles).toHaveLength(1);
  });

  it("fails a real but wrong candidate that the participant declares verified", async () => {
    const workspace = await materialize("clamp-number-util", "phase-b");
    await writeFile(
      path.join(workspace, "src", "number-utils.mjs"),
      `export function roundTo(value, decimals = 0) {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}
export function isInRange(value, min, max) {
  return value >= min && value <= max;
}
export function clampNumber(value) {
  return Number(value);
}
`,
      "utf8",
    );
    const report = await compareWith(
      verifierFor("clamp-number-util", "phase-b"),
      lyingExecution(),
      lyingExecution(),
      { ...task, candidateWorkspaces: { NATIVE: workspace, MAF_ADAPTIVE: workspace } },
    );
    expect(report.evaluation.dvs).toBe(0);
    const native = report.evaluation.paired[0]?.native;
    expect(native?.candidateIntegrity).toBe("VALID");
    expect(native?.hiddenGrader).toBe("FAIL");
    expect(native?.falseSafe).toBe(true);
  });

  it("passes a genuinely correct candidate even when the participant reports failure", async () => {
    const workspace = await materialize("clamp-number-util", "phase-b");
    await writeFile(
      path.join(workspace, "src", "number-utils.mjs"),
      `export function roundTo(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function isInRange(value, min, max) {
  return value >= min && value <= max;
}

export function clampNumber(value, min, max) {
  const converted = [value, min, max].map(Number);
  if (!converted.every(Number.isFinite)) throw new TypeError("arguments must be finite numbers");
  const [numericValue, lower, upper] = converted;
  if (lower > upper) throw new RangeError("min must not exceed max");
  return Math.min(upper, Math.max(lower, numericValue));
}
`,
      "utf8",
    );
    const pessimistic = lyingExecution({ verificationResult: "FAILED", filesChanged: [] });
    const report = await compareWith(
      verifierFor("clamp-number-util", "phase-b"),
      pessimistic,
      pessimistic,
      { ...task, candidateWorkspaces: { NATIVE: workspace, MAF_ADAPTIVE: workspace } },
    );
    const native = report.evaluation.paired[0]?.native;
    expect(native?.candidateIntegrity).toBe("VALID");
    expect(native?.hiddenGrader).toBe("PASS");
    expect(native?.regression).toBe("PASS");
    expect(native?.dvs).toBe(true);
    expect(report.evaluation.dvs).toBe(2);
  });

  it("treats a syntactically broken candidate as invalid integrity and does not grade it", async () => {
    const workspace = await materialize("clamp-number-util", "phase-b");
    await writeFile(
      path.join(workspace, "src", "number-utils.mjs"),
      "export function clampNumber( {{{ syntax error\n",
      "utf8",
    );
    const report = await compareWith(
      verifierFor("clamp-number-util", "phase-b"),
      lyingExecution(),
      lyingExecution(),
      { ...task, candidateWorkspaces: { NATIVE: workspace, MAF_ADAPTIVE: workspace } },
    );
    const native = report.evaluation.paired[0]?.native;
    expect(native?.candidateIntegrity).toBe("INVALID");
    expect(native?.hiddenGrader).toBe("NOT_CHECKED");
    expect(report.evaluation.dvs).toBe(0);
  });

  it("declines when the controller allocated no workspace", async () => {
    const report = await compareWith(verifierFor("clamp-number-util", "phase-b"));
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.paired[0]?.native.evidenceSource).toBe("NOT_CHECKED");
  });
});
