// NON-SCORING dry run for the Native-vs-MAF experiment plumbing (EXPERIMENT_PROTOCOL.md section 22
// / mission Phase 14 & 19).
//
// This exercises the real production machinery -- BenchmarkRunner.compare, both benchmark
// strategies, and the real CuratorIndependentVerifier -- against a synthetic, non-scoring fixture
// under evaluation/experiments/dry-run/. It never touches the frozen 29-task suite
// (evaluation/fixtures/phase-b, evaluation/fixtures/phase-c, evaluation/curator/phase-b,
// evaluation/curator/phase-c) and its result must never be counted toward experiment statistics.
//
// Usage: tsx evaluation/experiments/run-dry-run.ts  (or: npm run experiment:dry-run)

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BenchmarkRunner,
  type BenchmarkExecution,
  type BenchmarkExecutor,
  type BenchmarkTask,
} from "../../src/benchmark/runner";
import { CuratorIndependentVerifier } from "../../src/evaluation/curator-verifier";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const dryRunRoot = path.join(repoRoot, "evaluation", "experiments", "dry-run");
const pristineRepo = path.join(
  dryRunRoot,
  "fixtures",
  "dry-run-phase",
  "dry-run-task",
  "public",
  "repo",
);

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal .mjs source text being written to disk, not an interpolation
const FIXED_GREETING_SOURCE = "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n";

const applyFix = async (workspace: string): Promise<void> => {
  await writeFile(path.join(workspace, "src", "greet.mjs"), FIXED_GREETING_SOURCE, "utf8");
};

const dryRunExecutor = (
  strategy: BenchmarkExecutor["strategy"],
  workspace: string,
): BenchmarkExecutor => ({
  strategy,
  execute: async (_task: BenchmarkTask): Promise<BenchmarkExecution> => {
    const started = performance.now();
    await applyFix(workspace);
    const latencyMs = performance.now() - started;
    if (strategy === "NATIVE") {
      return {
        agent: "dry-run-native-mock",
        model: "none",
        provider: "local",
        initialMode: "NATIVE",
        finalMode: "NATIVE",
        modeTransitions: [],
        signalSnapshots: [],
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reportedCost: null,
        latencyMs,
        retryCount: 0,
        verificationAttempts: 1,
        repairAttempts: 0,
        verifierFailures: 0,
        verificationResult: "VERIFIED",
        filesChanged: ["src/greet.mjs"],
        modulesTouched: [],
        contextExpansion: 0,
        orchestrationOverheadMs: 0,
        runId: "dry-run:NATIVE:dry-run-task",
        candidateId: "dry-run-candidate:NATIVE",
        executionStatus: "COMPLETED",
      };
    }
    const runId = "dry-run:MAF_ADAPTIVE:dry-run-task";
    const snapshotId = "dry-run-snapshot-1";
    return {
      agent: "dry-run-maf-mock",
      model: "none",
      provider: "local",
      initialMode: "STRICT",
      finalMode: "GUIDED",
      modeTransitions: [
        {
          from: "STRICT",
          to: "GUIDED",
          reason: "dry-run synthetic escalation, exercised only to verify orchestration plumbing",
          signalSnapshotId: snapshotId,
        },
      ],
      signalSnapshots: [
        {
          id: snapshotId,
          runId,
          sequence: 1,
          checkpoint: "dry-run-checkpoint",
          timestamp: new Date().toISOString(),
          signals: {},
          evidence: [],
        },
      ],
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reportedCost: null,
      latencyMs,
      retryCount: 0,
      verificationAttempts: 1,
      repairAttempts: 0,
      verifierFailures: 0,
      verificationResult: "VERIFIED",
      filesChanged: ["src/greet.mjs"],
      modulesTouched: [],
      contextExpansion: 0,
      orchestrationOverheadMs: 5,
      runId,
      candidateId: "dry-run-candidate:MAF_ADAPTIVE",
      executionStatus: "COMPLETED",
    };
  },
});

const main = async (): Promise<void> => {
  const nativeWorkspace = await mkdtemp(path.join(tmpdir(), "maf-dry-run-native-"));
  const mafWorkspace = await mkdtemp(path.join(tmpdir(), "maf-dry-run-maf-"));
  try {
    await cp(pristineRepo, nativeWorkspace, { recursive: true });
    await cp(pristineRepo, mafWorkspace, { recursive: true });

    const task: BenchmarkTask = {
      id: "dry-run-task",
      prompt: "Fix greet() in src/greet.mjs to return the expected Hello greeting.",
      expectedVerification: 'greet("World") === "Hello, World!"',
      candidateWorkspaces: {
        NATIVE: nativeWorkspace,
        MAF_ADAPTIVE: mafWorkspace,
      },
    };

    const executors: BenchmarkExecutor[] = [
      dryRunExecutor("NATIVE", nativeWorkspace),
      dryRunExecutor("MAF_ADAPTIVE", mafWorkspace),
    ];

    const verifier = new CuratorIndependentVerifier({
      evaluationRoot: dryRunRoot,
      locate: (taskId) => (taskId === "dry-run-task" ? { phase: "dry-run-phase", taskId } : null),
    });

    const runner = new BenchmarkRunner();
    const report = await runner.compare(task, executors, { verifier });

    const wrapped = {
      status: "NON_SCORING" as const,
      tag: "NOT_PART_OF_EXPERIMENT" as const,
      generatedAt: new Date().toISOString(),
      note: "Synthetic plumbing check only. Never counted toward experiment statistics or DVS rate.",
      experimentManifest: "evaluation/experiments/native-vs-maf-v1.json",
      report,
    };

    const reportPath = path.join(dryRunRoot, "report.json");
    await writeFile(reportPath, `${JSON.stringify(wrapped, null, 2)}\n`, "utf8");

    const paired = report.evaluation.paired[0];
    process.stdout.write(
      [
        "NON_SCORING dry run complete.",
        `  paired outcome: ${paired?.outcome ?? "NONE"}`,
        `  native effectiveRunValidity=${paired?.native.effectiveRunValidity} dvs=${paired?.native.dvs} hiddenGrader=${paired?.native.hiddenGrader} regression=${paired?.native.regression}`,
        `  maf    effectiveRunValidity=${paired?.maf.effectiveRunValidity} dvs=${paired?.maf.dvs} hiddenGrader=${paired?.maf.hiddenGrader} regression=${paired?.maf.regression}`,
        `  cost accounting status: ${report.evaluation.cost.status}`,
        `  duration: meanElapsedOfDvsRunsMs=${report.evaluation.duration.meanElapsedOfDvsRunsMs}`,
        `  report written to ${path.relative(repoRoot, reportPath)}`,
      ].join("\n"),
    );
    process.stdout.write("\n");
  } finally {
    await rm(nativeWorkspace, { recursive: true, force: true });
    await rm(mafWorkspace, { recursive: true, force: true });
  }
};

await main();
