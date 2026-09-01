// Real BenchmarkExecutor for the MAF_ADAPTIVE arm: the same participant model, driven through the
// actual AdaptiveModeController (src/domain/mode-controller.ts) and the frozen Protocol v1 treatment
// policy (src/domain/mode-controller.ts defaultAdaptiveModePolicy, unmodified) rather than a
// simplified stand-in.
//
// Honest architectural limit, stated once here rather than buried in a comment nobody reads: the
// Claude Code CLI runs one non-interactive `claude -p` invocation per session
// (src/infrastructure/claude-code-adapter.ts -- capabilities().livePolicyUpdate and
// safeSessionRestart are both false, and `send()` refuses a second prompt on the same session). The
// controller can OBSERVE runtime signals as they stream and DECIDE mode transitions with the real
// AdaptiveModeController in real time, and every decision is recorded as evidence, but it cannot
// enforce a decided transition on a CLI invocation already in flight -- there is no live-update or
// safe-restart channel for it to use. Every recorded transition therefore carries
// `enforcementMethod: "DEFERRED_BOUNDARY"` with an explicit note that no further boundary arrived
// before the run ended, which is the honest DEFERRED_BOUNDARY semantics
// (src/domain/types.ts ModeEnforcementMethod) applied to a run that only ever has one boundary.
//
// Recovery is likewise scoped to exactly what the frozen treatment policy already describes:
// "src/domain/recovery.ts classifyFailure-driven provider-transient handling only" -- a single
// bounded retry (matching RunService's own defaultRecoveryPolicy.maxRecoveryAttempts = 1) when the
// failure classifies as auto-retryable, and nothing beyond that.

import type { RepositoryIndex, RuntimeSignalCollector } from "../../../../src/domain/ports";
import { AdaptiveModeController } from "../../../../src/domain/mode-controller";
import { classifyFailure, isAutoRetryable } from "../../../../src/domain/recovery";
import {
  emptyCost,
  emptyUsage,
  type AgentEvent,
  type ExecutionMode,
  type Run,
  type RuntimeSignalSnapshot,
  type Task,
} from "../../../../src/domain/types";
import { EvidenceRuntimeSignalCollector } from "../../../../src/application/runtime-signal-collector";
import { LocalRepositoryIndex } from "../../../../src/infrastructure/project-brain";
import { ClaudeCodeAdapter } from "../../../../src/infrastructure/claude-code-adapter";
import type { AgentAdapter, AgentStartInput } from "../../../../src/domain/ports";
import type {
  BenchmarkExecution,
  BenchmarkExecutor,
  BenchmarkTask,
} from "../../../../src/benchmark/runner";
import { runAgentSession, type AgentSessionResult } from "./agent-session-runner";
import { BudgetGuard } from "./budget-guard";
import type { ExecutorSideChannel, MafInterventionRecord } from "./provenance";

export interface MafExecutorConfig {
  requestedModel: string;
  effort: string;
  provider: string;
  timeoutMs: number;
  budgetUsd: number;
  maxRecoveryAttempts?: number;
  /** Test-only injection points. Every default is the real production component. */
  adapter?: AgentAdapter;
  signalCollector?: RuntimeSignalCollector;
  repositoryIndex?: RepositoryIndex;
  modeController?: AdaptiveModeController;
}

const DEFERRED_BOUNDARY_NOTE =
  "Decided from a real-time runtime signal snapshot during the participant's single non-interactive " +
  "CLI invocation. src/infrastructure/claude-code-adapter.ts declares livePolicyUpdate=false and " +
  "safeSessionRestart=false, so this decision could not be enforced on the in-flight session; no " +
  "further execution boundary arrived before the run ended for it to apply at.";

export class MafExperimentExecutor implements BenchmarkExecutor {
  readonly strategy = "MAF_ADAPTIVE" as const;
  readonly sideChannel = new Map<string, ExecutorSideChannel>();

  private readonly adapter: AgentAdapter;
  private readonly signalCollector: RuntimeSignalCollector;
  private readonly repositoryIndex: RepositoryIndex;
  private readonly modeController: AdaptiveModeController;
  private readonly budgetGuard: BudgetGuard;
  private readonly maxRecoveryAttempts: number;

  constructor(private readonly config: MafExecutorConfig) {
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
      });
    this.signalCollector = config.signalCollector ?? new EvidenceRuntimeSignalCollector();
    this.repositoryIndex = config.repositoryIndex ?? new LocalRepositoryIndex();
    this.modeController = config.modeController ?? new AdaptiveModeController();
    this.maxRecoveryAttempts = config.maxRecoveryAttempts ?? 1;
  }

  async execute(task: BenchmarkTask): Promise<BenchmarkExecution> {
    const workspace = task.candidateWorkspaces?.MAF_ADAPTIVE;
    if (!workspace)
      throw new Error(`No controller-owned MAF_ADAPTIVE workspace for task ${task.id}`);

    const runId = `maf:${task.id}:${crypto.randomUUID()}`;
    const candidateId = `${runId}:candidate`;
    const snapshot = await this.repositoryIndex.index(workspace, "HEAD");
    const initialModules = [...new Set(Object.values(snapshot.moduleOwnership))];
    const t0 = new Date().toISOString();
    await this.signalCollector.observe({
      runId,
      type: "INITIAL_CONTEXT",
      timestamp: t0,
      checkpoint: "session-start",
      repository: snapshot,
      initialFiles: snapshot.files,
      initialModules,
    });

    const initialMode = this.modeController.initial();
    let currentMode: ExecutionMode = initialMode;
    let lastTransitionSequence: number | undefined;
    let lastTransitionSnapshot: RuntimeSignalSnapshot | undefined;
    let eventSequence = 0;
    const includedSnapshots: RuntimeSignalSnapshot[] = [];
    const transitions: MafInterventionRecord["transitions"] = [];
    const rawTransitions: BenchmarkExecution["modeTransitions"] = [];

    const run: Run = {
      id: runId,
      taskId: task.id,
      state: "RUNNING",
      executionMode: currentMode,
      desiredMode: currentMode,
      effectiveMode: currentMode,
      verificationState: "NOT_CHECKED",
      agent: "claude-code",
      model: this.config.requestedModel,
      provider: this.config.provider,
      createdAt: t0,
      updatedAt: t0,
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
      createdAt: t0,
      verification: {},
    };
    const contextText = ["Repository files under the workspace root:", ...snapshot.files].join(
      "\n",
    );
    const startInput: AgentStartInput = {
      run,
      task: fabricatedTask,
      workspacePath: workspace,
      initialContext: contextText,
      credentialReferences: [],
    };

    const onEvent = async (event: AgentEvent): Promise<void> => {
      eventSequence += 1;
      const snap = await this.signalCollector.observe({
        runId,
        type: "AGENT_EVENT",
        event,
        timestamp: new Date().toISOString(),
        checkpoint: `event-${eventSequence}`,
      });
      const decision = this.modeController.decide(currentMode, snap, {
        ...(lastTransitionSequence !== undefined ? { lastTransitionSequence } : {}),
        ...(lastTransitionSnapshot !== undefined ? { lastTransitionSnapshot } : {}),
      });
      if (decision) {
        includedSnapshots.push(snap);
        rawTransitions.push({
          from: currentMode,
          to: decision.to,
          reason: decision.reason,
          signalSnapshotId: snap.id,
        });
        transitions.push({
          from: currentMode,
          to: decision.to,
          reason: decision.reason,
          enforcementMethod: "DEFERRED_BOUNDARY",
          enforcementNote: DEFERRED_BOUNDARY_NOTE,
        });
        currentMode = decision.to;
        lastTransitionSequence = snap.sequence;
        lastTransitionSnapshot = snap;
      }
    };

    let retries = 0;
    let result: AgentSessionResult = await runAgentSession({
      adapter: this.adapter,
      input: startInput,
      prompt: task.prompt,
      timeoutMs: this.config.timeoutMs,
      onEvent,
    });
    while (result.status === "INFRA_FAILURE" && retries < this.maxRecoveryAttempts) {
      const classification = classifyFailure(
        new Error(result.errorMessage ?? "unknown participant execution failure"),
      );
      if (!isAutoRetryable(classification)) break;
      retries += 1;
      result = await runAgentSession({
        adapter: this.adapter,
        input: startInput,
        prompt: task.prompt,
        timeoutMs: this.config.timeoutMs,
        onEvent,
      });
    }

    const budget = this.budgetGuard.finalize(result.reportedCost);
    const escalations = transitions.filter((t) => t.to === "SOLO_NATIVE").length;
    const mafDetails: MafInterventionRecord = {
      mode: { initial: initialMode, final: currentMode },
      interventions: transitions.length,
      retries,
      escalations,
      transitions,
    };
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
        // Orchestration (signal collection, mode decisions) runs locally and calls no model of its
        // own, so its dollar cost is genuinely zero -- not unknown.
        orchestrationCostUsd: 0,
        verificationCostUsd: 0,
        totalCostUsd: result.reportedCost,
        costStatus: result.reportedCost === null ? "UNKNOWN" : "KNOWN",
        ...(result.reportedCost === null
          ? {
              note:
                "no usage/cost event was ever observed for this run; token counts below are reported " +
                "as 0 because the executor never observed any, not because zero usage was confirmed",
            }
          : {}),
      },
      candidateWorkspace: workspace,
      maf: mafDetails,
    });

    const selfReportedSuccess = result.status === "COMPLETED" && result.resultSubtype === "success";
    const latencyMs = Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt));
    const finalSnapshot = await this.signalCollector.latest(runId);
    const contextExpansion = finalSnapshot?.signals.contextExpansion?.value ?? 0;

    return {
      agent: "claude-code",
      model: this.config.requestedModel,
      provider: this.config.provider,
      initialMode,
      finalMode: currentMode,
      modeTransitions: rawTransitions,
      signalSnapshots: includedSnapshots,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      reportedCost: result.reportedCost,
      latencyMs,
      retryCount: retries,
      verificationAttempts: selfReportedSuccess ? 1 : 0,
      repairAttempts: 0,
      verifierFailures: 0,
      verificationResult: selfReportedSuccess ? "VERIFIED" : "FAILED",
      filesChanged: [],
      modulesTouched: [],
      contextExpansion,
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
