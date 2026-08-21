import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import { benchmarkFamilies, type BenchmarkFamily } from "../src/benchmark/runner";
import { authorizeSpend, computeAllocation } from "../src/domain/budget";
import { AdaptiveModeController } from "../src/domain/mode-controller";
import { derivePerformancePosture, derivePerformanceSensitivity } from "../src/domain/performance";
import { classifyFailure } from "../src/domain/recovery";
import { deriveResiliencePosture, deriveResilienceRelevance } from "../src/domain/resilience";
import { deriveSecurityPosture } from "../src/domain/security";
import type { ExecutionMode, RuntimeSignalSnapshot } from "../src/domain/types";
import { LocalRepositoryIndex } from "../src/infrastructure/project-brain";

const strategy = process.argv[2];
if (strategy !== "NATIVE" && strategy !== "MAF_ADAPTIVE") {
  throw new Error("Expected NATIVE or MAF_ADAPTIVE strategy");
}
const family = process.env.MAF_BENCHMARK_FAMILY as BenchmarkFamily | undefined;
if (family && !benchmarkFamilies.includes(family)) throw new Error("Unknown benchmark family");
const taskId = process.env.MAF_BENCHMARK_TASK_ID ?? "single-fixture";
const executionRunId = `benchmark-run:${strategy}:${taskId}`;

const runGit = async (cwd: string, args: string[]): Promise<void> => {
  const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
};

const readGit = async (cwd: string, args: string[]): Promise<string> => {
  const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
};

const digestRevision = (revision: string): string =>
  createHash("sha256").update(revision).digest("hex");

const sequenceRoot = process.env.MAF_BENCHMARK_SEQUENCE_ROOT;
const sequenceId = process.env.MAF_BENCHMARK_SEQUENCE_ID;
const checkpointText = process.env.MAF_BENCHMARK_SEQUENCE_CHECKPOINT;
const hasAnySequenceInput = Boolean(sequenceRoot || sequenceId || checkpointText);
const checkpoint = checkpointText ? Number(checkpointText) : undefined;
if (
  hasAnySequenceInput &&
  (!sequenceRoot || !sequenceId || !checkpoint || !Number.isInteger(checkpoint) || checkpoint <= 0)
) {
  throw new Error("Incomplete benchmark sequence environment");
}
const sharedSequence = Boolean(sequenceRoot && sequenceId && checkpoint);
const safeSequenceId = sequenceId?.replace(/[^a-zA-Z0-9_.-]/gu, "_");

const workspace = sharedSequence
  ? path.join(sequenceRoot as string, safeSequenceId as string)
  : await mkdtemp(path.join(tmpdir(), "maf-benchmark-fixture-"));
let verificationResult: "VERIFIED" | "QUARANTINED" = "QUARANTINED";
let verificationAttempts = 1;
let repairAttempts = 0;
let verifierFailures = 0;
let mode: ExecutionMode | "NATIVE" = strategy === "NATIVE" ? "NATIVE" : "GUIDED";
const transitions: Array<{
  from: ExecutionMode;
  to: ExecutionMode;
  reason: string;
  signalSnapshotId?: string;
}> = [];
const signalSnapshots: RuntimeSignalSnapshot[] = [];
const touchedFiles = [
  "src/web/view.ts",
  "src/application/service.ts",
  "src/domain/model.ts",
  "src/platform/codec.ts",
  "src/infrastructure/store.ts",
];

try {
  const sources: Record<string, string> = {
    "src/web/view.ts":
      'import { service } from "../application/service";\nexport const view = service;\n',
    "src/application/service.ts":
      'import { model } from "../domain/model";\nimport { store } from "../infrastructure/store";\nexport const service = (): string => model() + "-" + store();\n',
    "src/domain/model.ts":
      'import { codec } from "../platform/codec";\nexport const model = codec;\n',
    "src/platform/codec.ts": 'export const codec = (): string => "ok";\n',
    "src/infrastructure/store.ts": 'export const store = (): string => "memory";\n',
  };
  if (!sharedSequence || checkpoint === 1) {
    for (const [file, source] of Object.entries(sources)) {
      const target = path.join(workspace, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source, "utf8");
    }
    await runGit(workspace, ["init", "-b", "main"]);
    await runGit(workspace, ["config", "user.email", "benchmark@example.invalid"]);
    await runGit(workspace, ["config", "user.name", "MAF Benchmark"]);
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", "realistic adaptive fixture"]);
  }
  const baseStateDigest =
    sharedSequence && checkpoint !== 1
      ? digestRevision(await readGit(workspace, ["rev-parse", "HEAD"]))
      : null;
  if (sharedSequence) {
    const checkpointFile = path.join(
      workspace,
      "evolution",
      `checkpoint-${String(checkpoint).padStart(2, "0")}.txt`,
    );
    await mkdir(path.dirname(checkpointFile), { recursive: true });
    await writeFile(checkpointFile, `${sequenceId}:${checkpoint}\n`, "utf8");
  }

  if (strategy === "MAF_ADAPTIVE") {
    const repository = await new LocalRepositoryIndex().index(workspace, "HEAD");
    const collector = new EvidenceRuntimeSignalCollector();
    const controller = new AdaptiveModeController();
    let lastSequence: number | undefined;
    let lastSnapshot: RuntimeSignalSnapshot | undefined;
    const decide = (snapshot: RuntimeSignalSnapshot): void => {
      signalSnapshots.push(snapshot);
      const decision = controller.decide(mode as ExecutionMode, snapshot, {
        ...(lastSequence !== undefined ? { lastTransitionSequence: lastSequence } : {}),
        ...(lastSnapshot ? { lastTransitionSnapshot: lastSnapshot } : {}),
      });
      if (!decision) return;
      const from = mode as ExecutionMode;
      mode = decision.to;
      transitions.push({
        from,
        to: decision.to,
        reason: decision.reason,
        ...(decision.signalSnapshotId ? { signalSnapshotId: decision.signalSnapshotId } : {}),
      });
      lastSequence = snapshot.sequence;
      lastSnapshot = snapshot;
    };
    decide(
      await collector.observe({
        runId: executionRunId,
        type: "INITIAL_CONTEXT",
        timestamp: new Date().toISOString(),
        checkpoint: "context-built",
        repository,
        initialFiles: ["src/web/view.ts"],
        initialModules: ["src/web"],
      }),
    );
    const observeTool = async (file: string, operation: string): Promise<void> => {
      const timestamp = new Date().toISOString();
      decide(
        await collector.observe({
          runId: executionRunId,
          type: "AGENT_EVENT",
          timestamp,
          checkpoint: "agent-tool",
          event: {
            type: "tool",
            data: { tool: operation, operation, path: file },
            timestamp,
          },
        }),
      );
    };
    await observeTool("src/application/service.ts", "read_file");
    await observeTool("src/domain/model.ts", "read_file");
    await observeTool("src/platform/codec.ts", "read_file");
    for (let index = 0; index < 5; index += 1) {
      await observeTool("src/platform/codec.ts", "edit_file");
    }
    await observeTool("src/infrastructure/store.ts", "read_file");
  }

  const output = path.join(workspace, "verified-output.txt");
  if (family === "VERIFIER_REPAIR") {
    await writeFile(output, "incorrect-before-repair\n", "utf8");
    if ((await readFile(output, "utf8")) !== "benchmark-fixture-ok\n") {
      verifierFailures = 1;
      repairAttempts = 1;
      verificationAttempts = 2;
    }
  }
  await writeFile(output, "benchmark-fixture-ok\n", "utf8");
  verificationResult =
    (await readFile(output, "utf8")) === "benchmark-fixture-ok\n" ? "VERIFIED" : "QUARANTINED";
  const latest = signalSnapshots.at(-1);
  const scenarioIndex = new LocalRepositoryIndex();
  const cheapSnapshot = await scenarioIndex.index(workspace, "HEAD");
  const snapshot = await scenarioIndex.indexScope(workspace, "HEAD", cheapSnapshot, touchedFiles);
  const scenarioChecks: string[] = [];
  const requireScenario = (condition: boolean, evidence: string): void => {
    if (!condition) throw new Error(`Benchmark scenario assertion failed: ${evidence}`);
    scenarioChecks.push(evidence);
  };
  if (family === "SMALL_MECHANICAL") {
    requireScenario(verificationResult === "VERIFIED", "bounded file change verified");
  } else if (family === "CROSS_MODULE_FEATURE") {
    requireScenario(
      snapshot.relations.some((relation) => relation.kind === "IMPORTS"),
      "cross-module import relation resolved",
    );
  } else if (family === "VERIFIER_REPAIR") {
    requireScenario(
      verifierFailures === 1 && repairAttempts === 1 && verificationAttempts === 2,
      "failed verification repaired and reverified",
    );
  } else if (family === "SECURITY_SENSITIVE") {
    const secret = `ghp_${"a".repeat(36)}`;
    const posture = deriveSecurityPosture(
      `diff --git a/src/config.ts b/src/config.ts\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -0,0 +1 @@\n+export const token = "${secret}";\n`,
    );
    requireScenario(
      posture.state === "FAIL" && !posture.findings.join(" ").includes(secret),
      "credential leak rejected with redacted evidence",
    );
  } else if (family === "DATA_CONSISTENCY") {
    const relevance = deriveResilienceRelevance(
      "diff --git a/src/store.ts b/src/store.ts\n--- a/src/store.ts\n+++ b/src/store.ts\n@@ -0,0 +1 @@\n+await db.transaction(async () => insert());\n",
      false,
    );
    requireScenario(
      relevance.scenarios.includes("DUPLICATE_REQUEST"),
      "consistency-critical write requires duplicate-request evidence",
    );
  } else if (family === "NETWORK_PERFORMANCE") {
    const sensitivity = derivePerformanceSensitivity(
      ["src/network/client.ts"],
      "diff --git a/src/network/client.ts b/src/network/client.ts\n--- a/src/network/client.ts\n+++ b/src/network/client.ts\n@@ -0,0 +1 @@\n+await fetch(url);\n",
    );
    const posture = derivePerformancePosture(
      {
        state: "MEASURED",
        candidateId: "fixture-candidate",
        diffDigest: "fixture-diff",
        metrics: [
          { name: "latency", unit: "ms", baseline: 100, candidate: 105, lowerIsBetter: true },
        ],
        evidence: ["deterministic local measurement"],
      },
      "fixture-candidate",
      "fixture-diff",
      10,
    );
    requireScenario(
      sensitivity.signals.includes("NETWORK_CALL") && posture.state === "PASS",
      "network sensitivity and bound performance delta evaluated",
    );
  } else if (family === "RESILIENCE_INJECTION") {
    const relevance = deriveResilienceRelevance(
      "diff --git a/src/client.ts b/src/client.ts\n--- a/src/client.ts\n+++ b/src/client.ts\n@@ -0,0 +1 @@\n+await fetch(url);\n",
      false,
    );
    const posture = deriveResiliencePosture(
      {
        state: "EXECUTED",
        candidateId: "fixture-candidate",
        diffDigest: "fixture-diff",
        scenarios: relevance.scenarios.map((scenario) => ({
          scenario,
          outcome: "PASSED",
          exitCode: 0,
          evidence: ["injected fixture passed"],
        })),
        evidence: ["deterministic local injection"],
      },
      "fixture-candidate",
      "fixture-diff",
      relevance,
    );
    requireScenario(posture.state === "PASS", "candidate-bound resilience scenarios executed");
  } else if (family === "PROVIDER_RECOVERY") {
    requireScenario(
      classifyFailure(new Error("request timed out")) === "PROVIDER_TRANSIENT",
      "provider timeout classified for bounded recovery",
    );
  } else if (family === "INSUFFICIENT_BUDGET") {
    const allocation = computeAllocation({ mode: "HARD", limitUsd: 1 });
    const authorization = authorizeSpend(
      allocation,
      { execution: allocation?.execution ?? 0, verification: 0, recovery: 0 },
      "execution",
      "HARD",
    );
    requireScenario(!authorization.authorized, "hard execution reserve exhaustion refused");
  } else if (family === "LONG_HORIZON_EVOLUTION") {
    requireScenario(
      sharedSequence && (checkpoint ?? 0) >= 10 && baseStateDigest !== null,
      "tenth checkpoint starts from prior chained state",
    );
  }
  if (sharedSequence) {
    await runGit(workspace, ["add", "."]);
    await runGit(workspace, ["commit", "-m", `evolution checkpoint ${checkpoint}`]);
  }
  const resultStateDigest = sharedSequence
    ? digestRevision(await readGit(workspace, ["rev-parse", "HEAD"]))
    : undefined;
  process.stdout.write(
    `${JSON.stringify({
      agent: "filesystem-fixture",
      model: "none",
      provider: "local",
      initialMode: strategy === "NATIVE" ? "NATIVE" : "GUIDED",
      finalMode: mode,
      modeTransitions: transitions,
      signalSnapshots,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reportedCost: null,
      latencyMs: 0,
      retryCount: family === "PROVIDER_RECOVERY" ? 1 : 0,
      verificationAttempts,
      repairAttempts,
      verifierFailures,
      verificationResult,
      filesChanged: ["verified-output.txt"],
      modulesTouched:
        strategy === "NATIVE"
          ? []
          : [...new Set(touchedFiles.map((file) => snapshot.moduleOwnership[file]))].filter(
              Boolean,
            ),
      contextExpansion: Number(latest?.signals.contextExpansion?.value ?? 0),
      orchestrationOverheadMs: 0,
      toolCalls: strategy === "NATIVE" ? 0 : 9,
      contextTokens: 0,
      runId: executionRunId,
      ...(resultStateDigest ? { candidateId: `benchmark-candidate:${resultStateDigest}` } : {}),
      ...(family
        ? { scenarioEvidence: { family, outcome: "EXERCISED", checks: scenarioChecks } }
        : {}),
      ...(sharedSequence
        ? {
            sequenceEvidence: {
              sequenceId,
              checkpoint,
              baseStateDigest,
              resultStateDigest,
              candidateStateDigest: resultStateDigest,
              verifiedStateDigest: resultStateDigest,
            },
          }
        : {}),
    })}\n`,
  );
} finally {
  if (!sharedSequence) await rm(workspace, { recursive: true, force: true });
}
