import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import { AdaptiveModeController } from "../src/domain/mode-controller";
import type { ExecutionMode, RuntimeSignalSnapshot } from "../src/domain/types";
import { LocalRepositoryIndex } from "../src/infrastructure/project-brain";

const strategy = process.argv[2];
if (strategy !== "NATIVE" && strategy !== "MAF_ADAPTIVE") {
  throw new Error("Expected NATIVE or MAF_ADAPTIVE strategy");
}

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

const workspace = await mkdtemp(path.join(tmpdir(), "maf-benchmark-fixture-"));
let verificationResult: "VERIFIED" | "QUARANTINED" = "QUARANTINED";
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
        runId: "benchmark-run",
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
          runId: "benchmark-run",
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
  await writeFile(output, "benchmark-fixture-ok\n", "utf8");
  verificationResult =
    (await readFile(output, "utf8")) === "benchmark-fixture-ok\n" ? "VERIFIED" : "QUARANTINED";
  const latest = signalSnapshots.at(-1);
  const snapshot = await new LocalRepositoryIndex().index(workspace, "HEAD");
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
      retryCount: 0,
      verificationAttempts: 1,
      repairAttempts: 0,
      verifierFailures: 0,
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
    })}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
