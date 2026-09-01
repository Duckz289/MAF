// Real BenchmarkExecutor for the NATIVE arm: ordinary Claude Code CLI execution, no MAF
// orchestration, no intervention. The controller still independently verifies the result afterwards
// (src/evaluation/curator-verifier.ts, wired in by ExperimentRunController) -- that verification is
// the controller's own doing, not something Native "receives" as help.
//
// Native must never receive hidden grader source, a reference candidate, hidden assertions, or the
// private adversarial corpus. This executor only ever hands the participant the task prompt; it
// never reads or forwards anything from evaluation/curator/**.

import type { AgentAdapter, AgentStartInput } from "../../../../src/domain/ports";
import { emptyCost, emptyUsage, type Run, type Task } from "../../../../src/domain/types";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeEffort,
} from "../../../../src/infrastructure/claude-code-adapter";
import type {
  BenchmarkExecution,
  BenchmarkExecutor,
  BenchmarkTask,
} from "../../../../src/benchmark/runner";
import { driveAttempts } from "./attempt-driver";
import { BudgetGuard } from "./budget-guard";
import { RunExecutionLedger } from "./run-ledger";
import { buildSideChannel, type ExperimentExecutorConfig } from "./executor-support";
import type { ExecutorSideChannel } from "./provenance";

export type NativeExecutorConfig = ExperimentExecutorConfig;

export class NativeExperimentExecutor implements BenchmarkExecutor {
  readonly strategy = "NATIVE" as const;
  /** Extra provenance detail BenchmarkExecution has no field for, keyed by the runId this executor
   *  put on its own sample. Populated after execute() resolves. */
  readonly sideChannel = new Map<string, ExecutorSideChannel>();

  private readonly adapter: AgentAdapter;
  private readonly budgetGuard: BudgetGuard;
  private readonly usingRealAdapter: boolean;
  /**
   * The exact config object the real adapter holds. `ClaudeCodeAdapter` reads `maxBudgetUsd` at
   * spawn time, so mutating this field between attempts is what makes each retry receive only the
   * REMAINING run budget instead of a fresh full per-run ceiling.
   */
  private readonly adapterConfig: { maxBudgetUsd: number };

  constructor(private readonly config: NativeExecutorConfig) {
    this.usingRealAdapter = config.adapter === undefined;
    this.budgetGuard = new BudgetGuard({
      limitUsd: config.budgetUsd,
      cliEnforcementAvailable: this.usingRealAdapter,
    });
    const adapterConfig = {
      model: config.requestedModel,
      // The controlled variable is now actually sent, not merely recorded.
      effort: config.effort as ClaudeCodeEffort,
      maxBudgetUsd: config.budgetUsd,
      permissionMode: "acceptEdits" as const,
      // Native receives no MAF framing at all -- the whole point of this arm.
      promptPreamble: "",
      ...(config.claudeCommand ? { command: config.claudeCommand } : {}),
    };
    this.adapterConfig = adapterConfig;
    this.adapter = config.adapter ?? new ClaudeCodeAdapter(adapterConfig);
  }

  async execute(task: BenchmarkTask): Promise<BenchmarkExecution> {
    const workspace = task.candidateWorkspaces?.NATIVE;
    if (!workspace) throw new Error(`No controller-owned NATIVE workspace for task ${task.id}`);

    const runId = `native:${task.id}:${crypto.randomUUID()}`;
    const candidateId = `${runId}:candidate`;
    const now = new Date().toISOString();
    const run: Run = {
      id: runId,
      taskId: task.id,
      state: "RUNNING",
      executionMode: "SOLO_NATIVE",
      desiredMode: "SOLO_NATIVE",
      effectiveMode: "SOLO_NATIVE",
      verificationState: "NOT_CHECKED",
      agent: "claude-code",
      model: this.config.requestedModel,
      provider: this.config.provider,
      createdAt: now,
      updatedAt: now,
      changedFiles: [],
      cost: emptyCost(),
      usage: emptyUsage(),
      retryCount: 0,
    };
    const fabricatedTask: Task = {
      id: task.id,
      prompt: task.prompt,
      repositoryPath: workspace,
      revision: "HEAD",
      createdAt: now,
      verification: {},
    };
    const startInput: AgentStartInput = {
      run,
      task: fabricatedTask,
      workspacePath: workspace,
      // No MAF-curated context: Native explores the workspace with its own native tools.
      initialContext: "",
      credentialReferences: [],
    };

    const ledger = new RunExecutionLedger({
      runBudgetUsd: this.config.budgetUsd,
      runTimeoutMs: this.config.timeoutMs,
      // NATIVE performs no orchestration and never retries: one run, one provider invocation.
      maxProviderInvocations: this.config.maxProviderInvocations ?? 1,
      ...(this.config.minimumAttemptBudgetUsd !== undefined
        ? { minimumAttemptBudgetUsd: this.config.minimumAttemptBudgetUsd }
        : {}),
      ...(this.config.minimumAttemptTimeMs !== undefined
        ? { minimumAttemptTimeMs: this.config.minimumAttemptTimeMs }
        : {}),
    });

    const driven = await driveAttempts({
      adapter: this.adapter,
      input: startInput,
      prompt: task.prompt,
      ledger,
      config: {
        requestedModel: this.config.requestedModel,
        effort: this.config.effort,
        effortArgumentEmitted: this.usingRealAdapter,
        maxRecoveryAttempts: 0,
        applyAttemptBudget: (attemptBudgetUsd) => {
          this.adapterConfig.maxBudgetUsd = attemptBudgetUsd;
        },
      },
    });

    this.sideChannel.set(
      runId,
      buildSideChannel({
        config: this.config,
        driven,
        ledger,
        budgetGuard: this.budgetGuard,
        effortArgumentEmitted: this.usingRealAdapter,
        candidateWorkspace: workspace,
      }),
    );

    const selfReportedSuccess = driven.finalOutcome.classification === "COMPLETED";
    return {
      agent: "claude-code",
      model: this.config.requestedModel,
      provider: this.config.provider,
      initialMode: "NATIVE",
      finalMode: "NATIVE",
      modeTransitions: [],
      signalSnapshots: [],
      inputTokens: driven.totals.inputTokens,
      outputTokens: driven.totals.outputTokens,
      cachedTokens: driven.totals.cachedTokens,
      reportedCost: driven.totals.costStatus === "UNKNOWN" ? null : driven.totals.knownCostUsd,
      latencyMs: Math.max(0, Date.parse(driven.finishedAt) - Date.parse(driven.startedAt)),
      retryCount: driven.retries,
      verificationAttempts: selfReportedSuccess ? 1 : 0,
      repairAttempts: 0,
      verifierFailures: 0,
      verificationResult: selfReportedSuccess ? "VERIFIED" : "FAILED",
      filesChanged: [],
      modulesTouched: [],
      contextExpansion: 0,
      orchestrationOverheadMs: 0,
      runId,
      candidateId,
      executionStatus: driven.finalOutcome.executionStatus,
      ...(driven.finalOutcome.classification === "COMPLETED" ||
      driven.finalOutcome.classification === "PARTICIPANT_TASK_FAILURE"
        ? {}
        : { providerError: driven.finalOutcome.firstFailure }),
    };
  }
}
