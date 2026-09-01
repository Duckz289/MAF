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
import {
  ClaudeCodeAdapter,
  type ClaudeCodeEffort,
} from "../../../../src/infrastructure/claude-code-adapter";
import type { AgentAdapter, AgentStartInput } from "../../../../src/domain/ports";
import type {
  BenchmarkExecution,
  BenchmarkExecutor,
  BenchmarkTask,
} from "../../../../src/benchmark/runner";
import { driveAttempts } from "./attempt-driver";
import { BudgetGuard } from "./budget-guard";
import { RunExecutionLedger } from "./run-ledger";
import { buildSideChannel, type ExperimentExecutorConfig } from "./executor-support";
import type { ExecutorSideChannel, MafInterventionRecord } from "./provenance";

export interface MafExecutorConfig extends ExperimentExecutorConfig {
  /** Test-only injection points. Every default is the real production component. */
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
  private readonly usingRealAdapter: boolean;
  /** The exact config object the real adapter holds; see NativeExperimentExecutor for why. */
  private readonly adapterConfig: { maxBudgetUsd: number };

  constructor(private readonly config: MafExecutorConfig) {
    this.usingRealAdapter = config.adapter === undefined;
    this.budgetGuard = new BudgetGuard({
      limitUsd: config.budgetUsd,
      cliEnforcementAvailable: this.usingRealAdapter,
    });
    const adapterConfig = {
      model: config.requestedModel,
      effort: config.effort as ClaudeCodeEffort,
      maxBudgetUsd: config.budgetUsd,
      permissionMode: "acceptEdits" as const,
      ...(config.claudeCommand ? { command: config.claudeCommand } : {}),
    };
    this.adapterConfig = adapterConfig;
    this.adapter = config.adapter ?? new ClaudeCodeAdapter(adapterConfig);
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

    const ledger = new RunExecutionLedger({
      runBudgetUsd: this.config.budgetUsd,
      runTimeoutMs: this.config.timeoutMs,
      // The ceiling is enforced BEFORE any spawn. The first billed preflight only reported
      // retryCount afterwards, which is far too late to stop money being spent.
      maxProviderInvocations: this.config.maxProviderInvocations ?? this.maxRecoveryAttempts + 1,
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
        maxRecoveryAttempts: this.maxRecoveryAttempts,
        applyAttemptBudget: (attemptBudgetUsd) => {
          this.adapterConfig.maxBudgetUsd = attemptBudgetUsd;
        },
      },
      onEvent,
    });

    const escalations = transitions.filter((t) => t.to === "SOLO_NATIVE").length;
    const mafDetails: MafInterventionRecord = {
      mode: { initial: initialMode, final: currentMode },
      interventions: transitions.length,
      retries: driven.retries,
      escalations,
      transitions,
    };
    this.sideChannel.set(
      runId,
      buildSideChannel({
        config: this.config,
        driven,
        ledger,
        budgetGuard: this.budgetGuard,
        effortArgumentEmitted: this.usingRealAdapter,
        candidateWorkspace: workspace,
        // Signal collection and mode decisions run locally in this process and call no model of
        // their own. Every provider invocation this run made is in `driven.attempts`, and each is
        // purpose PARTICIPANT -- so orchestration spend is genuinely zero, not merely assumed.
        orchestrationCostUsd: 0,
        maf: mafDetails,
      }),
    );

    const selfReportedSuccess = driven.finalOutcome.classification === "COMPLETED";
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
      contextExpansion,
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
