import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import { ClaudeCodeAdapter } from "../src/infrastructure/claude-code-adapter";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { runProcess } from "../src/infrastructure/process-utils";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";

const root = await mkdtemp(path.join(tmpdir(), "maf-real-agent-"));
const repository = path.join(root, "repository");
const sandboxes = path.join(root, "sandboxes");

try {
  await mkdir(repository);
  await runProcess("git", ["init", "-b", "main"], { cwd: repository });
  await runProcess("git", ["config", "user.email", "real-agent@example.invalid"], {
    cwd: repository,
  });
  await runProcess("git", ["config", "user.name", "MAF Real Agent"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "# Disposable real-agent fixture\n", "utf8");
  await runProcess("git", ["add", "."], { cwd: repository });
  await runProcess("git", ["commit", "-m", "fixture baseline"], { cwd: repository });

  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
  const service = new RunService({
    store,
    agent: new ClaudeCodeAdapter({
      command: process.env.CLAUDE_COMMAND ?? "claude",
      maxBudgetUsd: Number(process.env.CLAUDE_MAX_BUDGET_USD ?? 0.25),
      permissionMode: "acceptEdits",
    }),
    sandbox: new LocalWorktreeSandbox(sandboxes, "none"),
    verifier: new CommandVerifier(),
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry: new DomainTelemetryRecorder(),
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  const created = await service.create({
    prompt:
      "Create real-agent-output.txt containing exactly: MAF real agent verified. Do not modify any other file.",
    repositoryPath: repository,
    verification: { expectedFile: "real-agent-output.txt", timeoutMs: 120_000 },
    agent: "claude-code",
  });
  await service.waitForIdle(created.id, 180_000);
  const completed = await service.get(created.id);
  const explanation = await service.modeExplanation(created.id);
  process.stdout.write(
    `${JSON.stringify({
      classification:
        completed?.verificationState === "VERIFIED"
          ? "REAL_AGENT_VERIFIED"
          : "REAL_AGENT_VERIFICATION_BLOCKED",
      run: completed,
      modeExplanation: explanation,
    })}\n`,
  );
  if (completed?.verificationState !== "VERIFIED") process.exitCode = 2;
} finally {
  try {
    const status = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repository,
    });
    if (status.exitCode === 0) await runProcess("git", ["worktree", "prune"], { cwd: repository });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
