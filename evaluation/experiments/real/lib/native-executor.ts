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
import { ClaudeCodeAdapter } from "../../../../src/infrastructure/claude-code-adapter";
import type {
  BenchmarkExecution,
  BenchmarkExecutor,
  BenchmarkTask,
} from "../../../../src/benchmark/runner";
import { runAgentSession } from "./agent-session-runner";
import { BudgetGuard } from "./budget-guard";
import type { ExecutorSideChannel } from "./provenance";

export interface NativeExecutorConfig {
  requestedModel: string;
  effort: string;
  provider: string;
  timeoutMs: number;
  budgetUsd: number;
  /** Defaults to a real ClaudeCodeAdapter wired with the frozen model/effort/budget. Overridable
   *  only for tests, which inject a fake AgentAdapter double instead of spawning any process. */
  adapter?: AgentAdapter;
}

export class NativeExperimentExecutor implements BenchmarkExecutor {
  readonly strategy = "NATIVE" as const;
  /** Extra provenance detail BenchmarkExecution has no field for, keyed by the runId this executor
   *  put on its own sample. Populated after execute() resolves. */
  readonly sideChannel = new Map<string, ExecutorSideChannel>();

  private readonly adapter: AgentAdapter;
  private readonly budgetGuard: BudgetGuard;

  constructor(private readonly config: NativeExecutorConfig) {
    this.budgetGuard = new BudgetGuard({
      limitUsd: config.budgetUsd,
      cliEnforcementAvailable: config.adapter === undefined,
    });
    this.adapter =
      config.adapter ??
      new ClaudeCodeAdapter({
        model: config.requestedModel,
        maxBudgetUsd: this.budgetGuard.maxBudgetUsdForAdapter(),
        permissionMode: "acceptEdits",
        // Native receives no MAF framing at all -- the whole point of this arm.
        promptPreamble: "",
      });
  }

  async execute(task: BenchmarkTask): Promise<BenchmarkExecution> {
    const workspace = task.candidateWorkspaces?.NATIVE;
    if (!workspace) throw new Error(`No controller-owned NATIVE workspace for task ${task.id}`);

    const runId = `native:${task.id}:${crypto.randomUUID()}`;
    const candidateId = `${runId}:candidate`;
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: run.createdAt,
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

    const result = await runAgentSession({
      adapter: this.adapter,
      input: startInput,
      prompt: task.prompt,
      timeoutMs: this.config.timeoutMs,
    });

    const budget = this.budgetGuard.finalize(result.reportedCost);
    this.sideChannel.set(runId, {
      requestedModel: this.config.requestedModel,
      resolvedModel: result.resolvedModel,
      resolvedModelStatus: result.resolvedModel ? "RESOLVED" : "ALIAS_ONLY",
      effort: this.config.effort,
      provider: this.config.provider,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      timeout: { timeoutMs: this.config.timeoutMs, timedOut: result.status === "TIMEOUT" },
      budget,
      cost: {
        participantCostUsd: result.reportedCost,
        participantInputTokens: result.usage.inputTokens,
        participantOutputTokens: result.usage.outputTokens,
        participantCacheTokens: result.usage.cachedTokens,
        orchestrationCostUsd: 0,
        verificationCostUsd: 0,
        totalCostUsd: result.reportedCost,
        costStatus: result.reportedCost === null ? "UNKNOWN" : "KNOWN",
        ...(result.reportedCost === null
          ? {
              note:
                "no usage/cost event was ever observed for this run (e.g. it timed out or crashed " +
                "before the CLI emitted its final result line); token counts below are reported as " +
                "0 because the executor never observed any, not because zero usage was confirmed",
            }
          : {}),
      },
      candidateWorkspace: workspace,
    });

    const selfReportedSuccess = result.status === "COMPLETED" && result.resultSubtype === "success";
    const latencyMs = Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt));

    return {
      agent: "claude-code",
      model: this.config.requestedModel,
      provider: this.config.provider,
      initialMode: "NATIVE",
      finalMode: "NATIVE",
      modeTransitions: [],
      signalSnapshots: [],
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      reportedCost: result.reportedCost,
      latencyMs,
      retryCount: 0,
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
      executionStatus:
        result.status === "TIMEOUT"
          ? "TIMEOUT"
          : result.status === "INFRA_FAILURE"
            ? "INFRA_FAILURE"
            : "COMPLETED",
      ...(result.errorMessage ? { providerError: result.errorMessage } : {}),
    };
  }
}
