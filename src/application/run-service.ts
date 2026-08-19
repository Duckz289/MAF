import path from "node:path";
import type {
  AgentAdapter,
  AgentSession,
  ContextBuildResult,
  ContextBuilderPort,
  ProjectBrain,
  RepositoryIndex,
  RepositorySnapshot,
  RunStore,
  RuntimeSignalCollector,
  Sandbox,
  SandboxDiff,
  SandboxProvider,
  TelemetrySink,
  VerifierPort,
} from "../domain/ports";
import { AdaptiveModeController, type ModeDecision } from "../domain/mode-controller";
import {
  defaultEnforcementPolicy,
  planEnforcement,
  type EnforcementPolicy,
  type PendingModeEnforcement,
} from "../domain/policy-enforcement";
import { redactSensitiveData } from "../domain/security";
import {
  emptyCost,
  emptyUsage,
  type Artifact,
  type Event,
  type ExecutionMode,
  type ModeEnforcementMethod,
  type Run,
  type RuntimeSignals,
  type RuntimeSignalSnapshot,
  type Task,
  type Verification,
  type VerificationSpec,
} from "../domain/types";
import { LocalWorktreeSandbox } from "../infrastructure/local-worktree";

export interface CreateRunRequest {
  prompt: string;
  repositoryPath: string;
  revision?: string | undefined;
  mode?: ExecutionMode | undefined;
  verification?: VerificationSpec | undefined;
  signals?: RuntimeSignals | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  credentialReferences?: string[] | undefined;
}

export interface RunSummary extends Run {
  task: string;
  repositoryPath: string;
  revision: string;
  currentPhase: string;
  lastMeaningfulEvent?: { type: string; timestamp: string };
  modeTransitions: number;
  signalSnapshots: number;
  modeExplanation: ModeExplanation;
  operationalStatus: "QUEUED" | "RUNNING" | "STUCK" | "VERIFIED" | "FAILED" | "CANCELLED";
}

export interface ModeExplanation {
  /** Compatibility alias of {@link ModeExplanation.effectiveMode}. */
  mode: ExecutionMode;
  desiredMode: ExecutionMode;
  effectiveMode: ExecutionMode;
  pendingEnforcement?: {
    toDesired: ExecutionMode;
    method: ModeEnforcementMethod;
    requestedAt: string;
  };
  reason: string;
  latestSnapshotId?: string;
  latestSignals: RuntimeSignalSnapshot["signals"];
  timeline: Array<{
    from: ExecutionMode;
    to: ExecutionMode;
    reason: string;
    timestamp: string;
    signalSnapshotId?: string;
    enforcement?: ModeEnforcementMethod;
  }>;
}

interface RunServiceDependencies {
  store: RunStore;
  agent: AgentAdapter;
  sandbox: SandboxProvider;
  verifier: VerifierPort;
  repositoryIndex: RepositoryIndex;
  projectBrain: ProjectBrain;
  contextBuilder: ContextBuilderPort;
  telemetry: TelemetrySink;
  runtimeSignals: RuntimeSignalCollector;
  modeController?: AdaptiveModeController;
  repairPolicy?: Partial<VerificationRepairPolicy>;
  enforcementPolicy?: Partial<EnforcementPolicy>;
}

export interface VerificationRepairPolicy {
  maxRepairAttempts: number;
  maxVerifierOutputChars: number;
  maxDiffPreviewChars: number;
}

export const defaultVerificationRepairPolicy: VerificationRepairPolicy = {
  maxRepairAttempts: 1,
  maxVerifierOutputChars: 12_000,
  maxDiffPreviewChars: 12_000,
};

interface TransitionState {
  count: number;
  strictReexpansions: number;
  liveUpdates: number;
  boundaryEnforcements: number;
  safeRestarts: number;
  lastSequence?: number;
  lastSnapshot?: RuntimeSignalSnapshot;
}

interface Candidate {
  id: string;
  artifact: Artifact;
  diff: SandboxDiff;
  attempt: number;
}

interface ActiveRunState {
  cancelled: boolean;
  sandbox?: Sandbox;
  session?: AgentSession | undefined;
  sessionActive: boolean;
  pendingPolicy?: PendingModeEnforcement | undefined;
  policyRestartsUsed: number;
  transitionState: TransitionState;
  /**
   * The single live Run object the execute loop reads and writes. External callers (the
   * transition() API) MUST mutate this same object rather than a fresh store copy: the execute
   * loop periodically calls store.updateRun(run) with its own reference, and a second in-flight
   * writer would otherwise silently revert or race with those writes and desynchronize the
   * persisted state from the enforcement events already appended to the log.
   */
  run: Run;
}

/** Mutable holder so the current session context can be rebuilt when policy changes. */
interface ContextState {
  current: ContextBuildResult;
  mode: ExecutionMode;
  snapshot: RepositorySnapshot;
  projectId: string;
}

const newTransitionState = (): TransitionState => ({
  count: 0,
  strictReexpansions: 0,
  liveUpdates: 0,
  boundaryEnforcements: 0,
  safeRestarts: 0,
});

export class RunService {
  private readonly active = new Map<string, ActiveRunState>();
  private readonly modeController: AdaptiveModeController;
  private readonly repairPolicy: VerificationRepairPolicy;
  private readonly enforcementPolicy: EnforcementPolicy;

  constructor(private readonly dependencies: RunServiceDependencies) {
    this.modeController = dependencies.modeController ?? new AdaptiveModeController();
    this.repairPolicy = { ...defaultVerificationRepairPolicy, ...dependencies.repairPolicy };
    this.enforcementPolicy = { ...defaultEnforcementPolicy, ...dependencies.enforcementPolicy };
    if (this.repairPolicy.maxRepairAttempts < 0)
      throw new Error("Maximum repair attempts cannot be negative");
    if (this.enforcementPolicy.maxPolicyRestarts < 0)
      throw new Error("Maximum policy restarts cannot be negative");
  }

  async create(request: CreateRunRequest): Promise<Run> {
    const now = new Date().toISOString();
    const task: Task = {
      id: crypto.randomUUID(),
      prompt: request.prompt,
      repositoryPath: path.resolve(request.repositoryPath),
      revision: request.revision ?? "HEAD",
      createdAt: now,
      verification: request.verification ?? {},
      ...(request.signals ? { signals: request.signals } : {}),
    };
    const initialMode = this.modeController.initial(request.mode);
    const run: Run = {
      id: crypto.randomUUID(),
      taskId: task.id,
      state: "QUEUED",
      executionMode: initialMode,
      desiredMode: initialMode,
      effectiveMode: initialMode,
      verificationState: "PROPOSED",
      agent: request.agent ?? this.dependencies.agent.name,
      model: request.model ?? "native",
      provider: request.provider ?? "native",
      createdAt: now,
      updatedAt: now,
      changedFiles: [],
      cost: emptyCost(),
      usage: emptyUsage(),
      retryCount: 0,
    };
    await this.dependencies.store.createTask(task);
    await this.dependencies.store.createRun(run);
    await this.event(run.id, "RunCreated", {
      taskId: task.id,
      executionMode: run.executionMode,
      agent: run.agent,
      model: run.model,
    });
    this.active.set(run.id, {
      cancelled: false,
      sessionActive: false,
      policyRestartsUsed: 0,
      transitionState: newTransitionState(),
      run,
    });
    void this.execute(run, task, request.credentialReferences ?? []);
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    return this.dependencies.store.getRun(id);
  }

  async list(): Promise<Run[]> {
    return this.dependencies.store.listRuns();
  }

  async listSummaries(): Promise<RunSummary[]> {
    const runs = await this.dependencies.store.listRuns();
    return Promise.all(
      runs.map(async (run) => {
        const [task, events] = await Promise.all([
          this.dependencies.store.getTask(run.taskId),
          this.dependencies.store.listEvents(run.id),
        ]);
        const snapshots = await this.dependencies.store.listSignalSnapshots(run.id);
        const elapsed = Date.now() - Date.parse(run.startedAt ?? run.createdAt);
        const operationalStatus: RunSummary["operationalStatus"] =
          run.verificationState === "VERIFIED"
            ? "VERIFIED"
            : run.state === "FAILED"
              ? "FAILED"
              : run.state === "CANCELLED"
                ? "CANCELLED"
                : run.state === "COMPLETED"
                  ? "VERIFIED"
                  : run.state === "RUNNING" && elapsed > 5 * 60_000
                    ? "STUCK"
                    : run.state;
        const last = events.at(-1);
        return {
          ...run,
          task: task?.prompt ?? "Unknown task",
          repositoryPath: task?.repositoryPath ?? "",
          revision: task?.revision ?? "HEAD",
          currentPhase: this.currentPhase(run, last?.type),
          ...(last ? { lastMeaningfulEvent: { type: last.type, timestamp: last.timestamp } } : {}),
          modeTransitions: events.filter((event) => event.type === "ModeChanged").length,
          signalSnapshots: snapshots.length,
          modeExplanation: this.explain(run, events, snapshots),
          operationalStatus,
        };
      }),
    );
  }

  async events(id: string, after?: string): Promise<Event<unknown>[]> {
    return this.dependencies.store.listEvents(id, after);
  }

  async artifacts(id: string): Promise<Artifact[]> {
    return this.dependencies.store.listArtifacts(id);
  }

  async verifications(id: string): Promise<Verification[]> {
    await this.requireRun(id);
    return this.dependencies.store.listVerifications(id);
  }

  async signalSnapshots(id: string): Promise<RuntimeSignalSnapshot[]> {
    await this.requireRun(id);
    return this.dependencies.store.listSignalSnapshots(id);
  }

  async modeExplanation(id: string): Promise<ModeExplanation> {
    const active = this.active.get(id);
    const run = active ? active.run : await this.requireRun(id);
    const [events, snapshots] = await Promise.all([
      this.dependencies.store.listEvents(id),
      this.dependencies.store.listSignalSnapshots(id),
    ]);
    return this.explain(run, events, snapshots);
  }

  async waitForIdle(id: string, timeoutMs = 15_000): Promise<void> {
    const started = performance.now();
    while (this.active.has(id)) {
      if (performance.now() - started > timeoutMs) throw new Error(`Run ${id} did not become idle`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async cancel(id: string): Promise<Run> {
    const active = this.active.get(id);
    // Mutate the same live object the execute loop owns; see ActiveRunState.run.
    const run = active ? active.run : await this.requireRun(id);
    if (!active || run.state === "COMPLETED" || run.state === "FAILED") return structuredClone(run);
    active.cancelled = true;
    await this.dependencies.verifier.cancel(id);
    run.state = "CANCELLED";
    run.verificationState = "CANCELLED";
    run.updatedAt = new Date().toISOString();
    run.completedAt = run.updatedAt;
    await this.dependencies.store.updateRun(run);
    await this.event(id, "RunCancelled", {});
    return structuredClone(run);
  }

  async transition(
    id: string,
    to: ExecutionMode,
    reason: string,
    evidence: Record<string, unknown>,
  ): Promise<Run> {
    // If the run is still active, mutate the SAME live object the execute loop owns rather than
    // a fresh store copy — otherwise a concurrent store.updateRun(run) from the loop would race
    // with, or silently revert, this transition. See ActiveRunState.run.
    const active = this.active.get(id);
    const run = active ? active.run : await this.requireRun(id);
    if (run.desiredMode === to && run.effectiveMode === to) return structuredClone(run);
    await this.requestModeChange(run, {
      to,
      reason,
      evidence: redactSensitiveData({ ...evidence, source: "EXTERNAL_HINT" }) as Record<
        string,
        unknown
      >,
    });
    return structuredClone(run);
  }

  private async execute(run: Run, task: Task, credentialReferences: string[]): Promise<void> {
    const started = performance.now();
    const initialMode = run.effectiveMode;
    const activeState = this.active.get(run.id);
    const transitionState = activeState?.transitionState ?? newTransitionState();
    let modelCostReported = false;
    let sandbox: Sandbox | undefined;
    try {
      run.state = "RUNNING";
      run.startedAt = new Date().toISOString();
      run.updatedAt = run.startedAt;
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, "RunStarted", {});

      sandbox = await this.dependencies.sandbox.create(run.id, task.repositoryPath, task.revision);
      const active = this.active.get(run.id);
      if (active) active.sandbox = sandbox;
      run.sandboxPath = sandbox.path;
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, "SandboxStarted", {
        provider: "LocalWorktree",
        path: sandbox.path,
        revision: sandbox.revision,
      });

      await this.dependencies.projectBrain.markStale(task.repositoryPath, task.revision);
      const snapshot = await this.dependencies.repositoryIndex.index(sandbox.path, task.revision);
      const context = await this.dependencies.contextBuilder.build({
        task,
        mode: run.effectiveMode,
        snapshot,
        projectId: task.repositoryPath,
      });
      const contextState: ContextState = {
        current: context,
        mode: run.effectiveMode,
        snapshot,
        projectId: task.repositoryPath,
      };
      await this.event(run.id, "ContextBuilt", {
        tokenEstimate: context.tokenEstimate,
        evidenceIds: context.evidenceIds,
        modules: Object.keys(snapshot.moduleMap).length,
        symbols: snapshot.symbols.length,
        initialFiles: context.initialFiles,
        initialModules: context.initialModules,
      });

      await this.observeAndDecide(run, {
        runId: run.id,
        type: "INITIAL_CONTEXT",
        timestamp: new Date().toISOString(),
        checkpoint: "context-built",
        repository: snapshot,
        initialFiles: context.initialFiles,
        initialModules: context.initialModules,
        ...(task.signals ? { externalHints: task.signals } : {}),
      });

      const securityBoundary = await this.dependencies.agent.securityBoundary?.();
      if (securityBoundary) await this.event(run.id, "AgentSecurityBoundary", securityBoundary);
      const capabilities = await this.dependencies.agent.capabilities();
      await this.refreshContext(run, task, contextState);
      let sessionResult = await this.runGovernedSession(
        run,
        task,
        sandbox,
        contextState,
        credentialReferences,
        task.prompt,
      );
      modelCostReported ||= sessionResult.modelCostReported;
      let session = sessionResult.session;
      let verification: Verification | undefined;
      let candidate: Candidate | undefined;
      let parentCandidateId: string | undefined;
      let verificationAttempts = 0;
      let repairAttempts = 0;

      for (;;) {
        candidate = await this.captureCandidate(
          run,
          sandbox,
          verificationAttempts + 1,
          parentCandidateId,
        );
        verificationAttempts += 1;
        run.verificationState = "VERIFYING";
        await this.dependencies.store.updateRun(run);
        await this.event(run.id, "VerificationChanged", {
          state: "VERIFYING",
          attempt: verificationAttempts,
          candidateId: candidate.id,
        });
        verification = await this.dependencies.verifier.verify(run, task, sandbox, candidate.diff);
        verification.attempt = verificationAttempts;
        verification.candidateId = candidate.id;
        await this.dependencies.store.addVerification(verification);
        await this.observeAndDecide(run, {
          runId: run.id,
          type: "VERIFICATION",
          timestamp: verification.completedAt,
          checkpoint: `verification-attempt-${verificationAttempts}-${verification.state.toLowerCase()}`,
          verification,
        });
        await this.event(run.id, "VerificationChanged", {
          state: verification.state,
          attempt: verificationAttempts,
          candidateId: candidate.id,
          exitCode: verification.exitCode,
          output: verification.output,
        });
        if (verification.state === "VERIFIED") break;

        const previousVerification = (await this.dependencies.store.listVerifications(run.id)).at(
          -2,
        );
        const worseState =
          previousVerification !== undefined &&
          this.verificationSeverity(verification) > this.verificationSeverity(previousVerification);
        if (repairAttempts >= this.repairPolicy.maxRepairAttempts || worseState) {
          await this.event(run.id, "VerificationRepairStopped", {
            reason: worseState ? "verification-state-worsened" : "repair-limit-reached",
            verificationAttempts,
            repairAttempts,
            maxRepairAttempts: this.repairPolicy.maxRepairAttempts,
            candidateId: candidate.id,
          });
          break;
        }

        repairAttempts += 1;
        run.retryCount = repairAttempts;
        run.updatedAt = new Date().toISOString();
        await this.dependencies.store.updateRun(run);
        const repairMessage = this.repairMessage(task, verification, candidate, repairAttempts);
        await this.event(run.id, "VerificationRepairStarted", {
          repairAttempt: repairAttempts,
          failedVerificationId: verification.id,
          candidateId: candidate.id,
          command: task.verification.command ?? null,
          exitCode: verification.exitCode ?? null,
          output: verification.output.slice(0, this.repairPolicy.maxVerifierOutputChars),
          changedFiles: candidate.diff.changedFiles,
          diffDigest: candidate.artifact.digest,
          sessionStrategy:
            capabilities.resumeSession && session.nativeSessionId
              ? "NATIVE_RESUME"
              : "NEW_BOUNDED_SESSION",
        });
        parentCandidateId = candidate.id;
        await this.refreshContext(run, task, contextState);
        sessionResult = await this.runGovernedSession(
          run,
          task,
          sandbox,
          contextState,
          credentialReferences,
          repairMessage,
          capabilities.resumeSession ? session : undefined,
        );
        modelCostReported ||= sessionResult.modelCostReported;
        session = sessionResult.session;
      }

      if (!verification) throw new Error("Trusted verification did not run");
      run.verificationState = verification.state;
      run.state = verification.state === "VERIFIED" ? "COMPLETED" : "FAILED";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, "RunCompleted", {
        state: run.state,
        verificationState: run.verificationState,
        verificationAttempts,
        repairAttempts,
      });
      try {
        const latestSignals = await this.dependencies.runtimeSignals.latest(run.id);
        const signalValues = latestSignals?.signals;
        await this.dependencies.telemetry.record({
          taskId: task.id,
          runId: run.id,
          agent: run.agent,
          model: run.model,
          provider: run.provider,
          initialMode,
          finalMode: run.effectiveMode,
          finalDesiredMode: run.desiredMode,
          executionMode: run.effectiveMode,
          policyLiveUpdates: transitionState.liveUpdates,
          policyBoundaryEnforcements: transitionState.boundaryEnforcements,
          policySafeRestarts: transitionState.safeRestarts,
          pendingPolicyAtCompletion: Boolean(this.active.get(run.id)?.pendingPolicy),
          inputTokens: run.usage.input,
          outputTokens: run.usage.output,
          cachedTokens: run.usage.cached,
          modelCost: modelCostReported ? run.cost.model : null,
          sandboxCost: run.cost.sandbox,
          verificationCost: run.cost.verification,
          retryCost: run.cost.retry,
          recoveryCost: run.cost.recovery,
          latencyMs: performance.now() - started,
          retryCount: run.retryCount,
          filesChanged: run.changedFiles.length,
          verificationType: "command",
          verificationState: run.verificationState,
          modeTransitions: transitionState.count,
          strictReexpansions: transitionState.strictReexpansions,
          signalSnapshots: (await this.dependencies.store.listSignalSnapshots(run.id)).length,
          ...(latestSignals ? { latestSignalSnapshotId: latestSignals.id } : {}),
          dependencyExpansion: Number(signalValues?.dependencyExpansion?.value ?? 0),
          touchedModules: Number(signalValues?.touchedModules?.value ?? 0),
          crossModuleEdges: Number(signalValues?.crossModuleEdges?.value ?? 0),
          verifierFailures: Number(signalValues?.repeatedVerifierFailures?.value ?? 0),
          verificationAttempts,
          repairAttempts,
          moduleCountObserved: Number(signalValues?.touchedModules?.value ?? 0),
          stabilizationInvalidations: Number(signalValues?.stabilizationInvalidations?.value ?? 0),
          contextExpansion: Number(signalValues?.contextExpansion?.value ?? 0),
          verifiedSuccess: run.verificationState === "VERIFIED",
          timestamp: run.completedAt,
        });
      } catch (telemetryError) {
        await this.event(run.id, "TelemetryFailed", {
          error: telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
        });
      }
    } catch (error) {
      const latest = await this.dependencies.store.getRun(run.id);
      if (latest?.state !== "CANCELLED") {
        run.state = "FAILED";
        run.verificationState = run.verificationState === "VERIFYING" ? "QUARANTINED" : "FAILED";
        run.error = error instanceof Error ? error.message : String(error);
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        await this.dependencies.store.updateRun(run);
        await this.event(run.id, "RunFailed", { error: run.error });
      }
    } finally {
      if (sandbox) {
        try {
          await this.dependencies.sandbox.cleanup(sandbox, run.verificationState);
          await this.event(run.id, "SandboxFinalized", {
            verificationState: run.verificationState,
          });
        } catch (cleanupError) {
          await this.event(run.id, "SandboxCleanupFailed", {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      this.active.delete(run.id);
    }
  }

  /**
   * Runs one agent session under policy control. Handles bounded safe restarts and applies any
   * still-pending policy at the safe boundary once the session has genuinely ended.
   */
  private async runGovernedSession(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
    credentialReferences: string[],
    message: string,
    resumeFrom?: AgentSession,
  ): Promise<{ session: AgentSession; modelCostReported: boolean }> {
    let result = await this.runAgentAttempt(
      run,
      task,
      sandbox,
      contextState.current.text,
      credentialReferences,
      message,
      resumeFrom,
    );
    let modelCostReported = result.modelCostReported;
    for (;;) {
      const active = this.active.get(run.id);
      const pending = active?.pendingPolicy;
      if (!result.restartRequested || !active || pending?.method !== "SAFE_RESTART") break;
      active.pendingPolicy = undefined;
      active.policyRestartsUsed += 1;
      await this.enforce(run, pending.decision, {
        method: "SAFE_RESTART",
        evidence: {
          restartedSessionId: result.session.id,
          restartCount: active.policyRestartsUsed,
          maxPolicyRestarts: this.enforcementPolicy.maxPolicyRestarts,
          workspacePreserved: true,
        },
      });
      await this.refreshContext(run, task, contextState);
      // Preserve whatever the interrupted session was actually working on — the original task on
      // a first attempt, or the verifier repair instructions if this restart interrupted a bounded
      // repair. Always falling back to task.prompt would silently discard repair evidence and
      // waste the bounded repair attempt the session was mid-way through.
      const continuation = [
        `Execution policy changed to ${run.effectiveMode}: ${pending.decision.reason}.`,
        "policy-restart-continuation: continue the interrupted work in the same workspace.",
        message,
      ].join("\n");
      result = await this.runAgentAttempt(
        run,
        task,
        sandbox,
        contextState.current.text,
        credentialReferences,
        continuation,
      );
      modelCostReported ||= result.modelCostReported;
    }
    await this.applyPendingAtBoundary(run, "agent-session-ended");
    return { session: result.session, modelCostReported };
  }

  private async runAgentAttempt(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    initialContext: string,
    credentialReferences: string[],
    message: string,
    resumeFrom?: AgentSession,
  ): Promise<{ session: AgentSession; modelCostReported: boolean; restartRequested: boolean }> {
    const session =
      resumeFrom?.nativeSessionId !== undefined
        ? await this.dependencies.agent.resume(resumeFrom.nativeSessionId)
        : await this.dependencies.agent.start({
            run,
            task,
            workspacePath: sandbox.path,
            initialContext,
            credentialReferences,
          });
    const active = this.active.get(run.id);
    if (active) {
      active.session = session;
      active.sessionActive = true;
    }
    let modelCostReported = false;
    let restartRequested = false;
    try {
      await this.dependencies.agent.send(session, message);
      for await (const agentEvent of this.dependencies.agent.events(session)) {
        if (this.active.get(run.id)?.cancelled) {
          await this.dependencies.agent.cancel(session);
          throw new Error("Run cancelled");
        }
        await this.event(run.id, "AgentEvent", {
          ...agentEvent,
          executionAttempt: run.retryCount + 1,
        });
        if (agentEvent.type === "usage") {
          run.usage.input += Number(agentEvent.data.inputTokens ?? 0);
          run.usage.output += Number(agentEvent.data.outputTokens ?? 0);
          run.usage.cached += Number(agentEvent.data.cachedTokens ?? 0);
          if (typeof agentEvent.data.costUsd === "number") {
            modelCostReported = true;
            run.cost.model += agentEvent.data.costUsd;
            run.cost.total =
              run.cost.model +
              run.cost.sandbox +
              run.cost.verification +
              run.cost.retry +
              run.cost.recovery;
          }
        }
        if (agentEvent.type === "policy") {
          await this.handlePolicyAcknowledgement(run, agentEvent.data, agentEvent.timestamp);
        }
        if (agentEvent.type === "context_expansion") {
          await this.event(run.id, "ContextExpanded", {
            ...agentEvent.data,
            executionAttempt: run.retryCount + 1,
          });
        }
        if (agentEvent.type === "tool" || agentEvent.type === "context_expansion") {
          await this.observeAndDecide(run, {
            runId: run.id,
            type: "AGENT_EVENT",
            timestamp: agentEvent.timestamp,
            checkpoint:
              run.retryCount === 0
                ? `agent-${agentEvent.type}`
                : `verification-repair-${run.retryCount}-${agentEvent.type}`,
            event: agentEvent,
          });
        }
        if (agentEvent.type === "error") {
          throw new Error(String(agentEvent.data.message ?? "Agent failed"));
        }
        if (this.active.get(run.id)?.pendingPolicy?.method === "SAFE_RESTART") {
          restartRequested = true;
          await this.dependencies.agent.cancel(session);
          break;
        }
      }
    } finally {
      const current = this.active.get(run.id);
      if (current) {
        current.sessionActive = false;
        current.session = undefined;
      }
    }
    return { session, modelCostReported, restartRequested };
  }

  /** A live policy update becomes effective only after the session acknowledges it. */
  private async handlePolicyAcknowledgement(
    run: Run,
    data: Record<string, unknown>,
    timestamp: string,
  ): Promise<void> {
    const active = this.active.get(run.id);
    const pending = active?.pendingPolicy;
    if (!active || pending?.method !== "LIVE_UPDATE") return;
    const acknowledgedMode = String(data.acknowledgedMode ?? "");
    // The requestId echo is the only real evidence the session applied THIS update. An ack
    // without the exact echo is an unverified agent claim and must not change effective mode.
    if (acknowledgedMode !== pending.decision.to || data.requestId !== pending.requestId) return;
    active.pendingPolicy = undefined;
    await this.enforce(run, pending.decision, {
      method: "LIVE_UPDATE",
      evidence: {
        requestId: pending.requestId,
        acknowledgedRequestId: data.requestId,
        acknowledgedMode,
        acknowledgedAt: timestamp,
      },
    });
  }

  /**
   * Registers a new desired mode and enforces it through the planned strategy. Desired state is
   * recorded immediately; effective state changes only with enforcement evidence.
   */
  private async requestModeChange(
    run: Run,
    decision: ModeDecision,
    snapshot?: RuntimeSignalSnapshot,
  ): Promise<void> {
    const now = new Date().toISOString();
    const active = this.active.get(run.id);
    const fromDesired = run.desiredMode;
    run.desiredMode = decision.to;
    run.updatedAt = now;
    await this.dependencies.store.updateRun(run);
    const capabilities = await this.dependencies.agent.capabilities();
    const method = planEnforcement(
      decision,
      run.effectiveMode,
      capabilities,
      {
        sessionActive: active?.sessionActive ?? false,
        policyRestartsUsed: active?.policyRestartsUsed ?? 0,
      },
      this.enforcementPolicy,
    );
    await this.event(run.id, "ModeChangeRequested", {
      fromDesired,
      toDesired: decision.to,
      effectiveMode: run.effectiveMode,
      reason: decision.reason,
      evidence: decision.evidence,
      plannedEnforcement: method,
      ...(decision.signalSnapshotId ? { signalSnapshotId: decision.signalSnapshotId } : {}),
      ...(decision.evidenceIds ? { evidenceIds: decision.evidenceIds } : {}),
    });
    if (active?.transitionState && snapshot) {
      active.transitionState.lastSequence = snapshot.sequence;
      active.transitionState.lastSnapshot = snapshot;
    }
    if (active?.pendingPolicy && active.pendingPolicy.decision.to !== decision.to) {
      await this.event(run.id, "ModeEnforcementSuperseded", {
        supersededToDesired: active.pendingPolicy.decision.to,
        supersededMethod: active.pendingPolicy.method,
        replacedByToDesired: decision.to,
      });
    }
    if (method === "SESSION_BOUNDARY") {
      await this.enforce(run, decision, {
        method,
        evidence: {
          sessionActive: false,
          detail: "No active agent session; the next session starts under this policy",
        },
      });
      return;
    }
    if (!active) return;
    if (method === "LIVE_UPDATE") {
      const requestId = crypto.randomUUID();
      const delivered =
        active.session !== undefined
          ? ((await this.dependencies.agent.updatePolicy?.(active.session, {
              mode: decision.to,
              reason: decision.reason,
              requestId,
            })) ?? false)
          : false;
      if (delivered) {
        active.pendingPolicy = {
          decision,
          fromEffective: run.effectiveMode,
          method: "LIVE_UPDATE",
          requestId,
          requestedAt: now,
        };
      } else {
        active.pendingPolicy = {
          decision,
          fromEffective: run.effectiveMode,
          method: "DEFERRED_BOUNDARY",
          requestId,
          requestedAt: now,
        };
        await this.event(run.id, "ModeEnforcementDeferred", {
          requestId,
          toDesired: decision.to,
          cause: "policy-update-delivery-failed",
        });
      }
      return;
    }
    active.pendingPolicy = {
      decision,
      fromEffective: run.effectiveMode,
      method,
      requestId: crypto.randomUUID(),
      requestedAt: now,
    };
  }

  /** Applies a still-pending policy at a safe execution boundary. */
  private async applyPendingAtBoundary(run: Run, checkpoint: string): Promise<void> {
    const active = this.active.get(run.id);
    const pending = active?.pendingPolicy;
    if (!active || !pending) return;
    active.pendingPolicy = undefined;
    await this.enforce(run, pending.decision, {
      method: "DEFERRED_BOUNDARY",
      evidence: {
        checkpoint,
        plannedMethod: pending.method,
        requestedAt: pending.requestedAt,
        detail: "Policy applied at a safe execution boundary; the session it targeted has ended",
      },
    });
  }

  /** The single place an effective mode changes: records the enforcement event and counters. */
  private async enforce(
    run: Run,
    decision: ModeDecision,
    enforcement: { method: ModeEnforcementMethod; evidence: Record<string, unknown> },
  ): Promise<void> {
    const fromEffective = run.effectiveMode;
    if (fromEffective === decision.to) {
      // Desired mode already flip-flopped back to the current effective mode before this
      // enforcement landed (e.g. a superseded pending was overtaken by a newer decision that
      // matches what is already running). Nothing actually changed; recording a same-to-same
      // ModeChanged would inflate transition counts and misrepresent a real transition.
      await this.event(run.id, "ModeEnforcementNoop", {
        mode: fromEffective,
        method: enforcement.method,
        reason: decision.reason,
      });
      return;
    }
    const event = this.modeController.apply(run, decision, enforcement);
    await this.dependencies.store.updateRun(run);
    await this.dependencies.store.appendEvent(event);
    const transitionState = this.active.get(run.id)?.transitionState;
    if (!transitionState) return;
    transitionState.count += 1;
    if (fromEffective === "STRICT") transitionState.strictReexpansions += 1;
    if (enforcement.method === "LIVE_UPDATE") transitionState.liveUpdates += 1;
    else if (enforcement.method === "SAFE_RESTART") transitionState.safeRestarts += 1;
    else transitionState.boundaryEnforcements += 1;
  }

  /** Rebuilds the session context when the effective mode changed since the last build. */
  private async refreshContext(run: Run, task: Task, contextState: ContextState): Promise<void> {
    if (contextState.mode === run.effectiveMode) return;
    const rebuilt = await this.dependencies.contextBuilder.build({
      task,
      mode: run.effectiveMode,
      snapshot: contextState.snapshot,
      projectId: contextState.projectId,
    });
    contextState.current = rebuilt;
    contextState.mode = run.effectiveMode;
    await this.event(run.id, "ContextRebuilt", {
      mode: run.effectiveMode,
      tokenEstimate: rebuilt.tokenEstimate,
      initialFiles: rebuilt.initialFiles,
      initialModules: rebuilt.initialModules,
    });
  }

  private async captureCandidate(
    run: Run,
    sandbox: Sandbox,
    attempt: number,
    parentCandidateId: string | undefined,
  ): Promise<Candidate> {
    const diff = await this.dependencies.sandbox.collectDiff(sandbox);
    run.changedFiles = diff.changedFiles;
    run.updatedAt = new Date().toISOString();
    await this.dependencies.store.updateRun(run);
    const id = crypto.randomUUID();
    const artifact: Artifact = {
      id,
      runId: run.id,
      kind: "DIFF",
      uri: `sandbox://${run.id}/candidate-${attempt}.patch`,
      digest: LocalWorktreeSandbox.digest(diff),
      metadata: redactSensitiveData({
        candidateId: id,
        attempt,
        parentCandidateId: parentCandidateId ?? null,
        changedFiles: diff.changedFiles,
        bytes: Buffer.byteLength(diff.patch),
        preview: diff.patch.slice(0, this.repairPolicy.maxDiffPreviewChars),
      }) as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    await this.dependencies.store.addArtifact(artifact);
    await this.event(run.id, "DiffCaptured", {
      artifactId: artifact.id,
      candidateId: id,
      parentCandidateId: parentCandidateId ?? null,
      attempt,
      changedFiles: diff.changedFiles,
      digest: artifact.digest,
    });
    await this.observeAndDecide(run, {
      runId: run.id,
      type: "DIFF_CAPTURED",
      timestamp: new Date().toISOString(),
      checkpoint: attempt === 1 ? "diff-captured" : `verification-repair-${attempt - 1}-diff`,
      diff,
    });
    return { id, artifact, diff, attempt };
  }

  private repairMessage(
    task: Task,
    verification: Verification,
    candidate: Candidate,
    repairAttempt: number,
  ): string {
    const evidence = redactSensitiveData({
      repairAttempt,
      verificationAttempt: verification.attempt,
      verificationId: verification.id,
      candidateId: candidate.id,
      command: task.verification.command ?? null,
      expectedFile: task.verification.expectedFile ?? null,
      exitCode: verification.exitCode ?? null,
      output: verification.output.slice(0, this.repairPolicy.maxVerifierOutputChars),
      changedFiles: candidate.diff.changedFiles,
      diffDigest: candidate.artifact.digest,
      diffPreview: candidate.diff.patch.slice(0, this.repairPolicy.maxDiffPreviewChars),
    });
    return [
      "Trusted verification repair request.",
      "The verifier is authoritative. Repair the candidate in the existing workspace and do not claim success without another verifier pass.",
      JSON.stringify(evidence, null, 2),
    ].join("\n\n");
  }

  private verificationSeverity(verification: Verification): number {
    if (verification.state === "VERIFIED") return 0;
    if (verification.state === "QUARANTINED") return 1;
    if (verification.state === "FAILED") return 2;
    return 3;
  }

  private async event(runId: string, type: string, data: unknown): Promise<void> {
    await this.dependencies.store.appendEvent({
      id: crypto.randomUUID(),
      runId,
      type,
      timestamp: new Date().toISOString(),
      data: redactSensitiveData(data),
    });
  }

  private async observeAndDecide(
    run: Run,
    observation: Parameters<RuntimeSignalCollector["observe"]>[0],
  ): Promise<RuntimeSignalSnapshot> {
    const snapshot = await this.dependencies.runtimeSignals.observe(observation);
    await this.dependencies.store.addSignalSnapshot(snapshot);
    await this.event(run.id, "RuntimeSignalsObserved", snapshot);
    const transitionState = this.active.get(run.id)?.transitionState;
    const decision = this.modeController.decide(run.desiredMode, snapshot, {
      ...(transitionState?.lastSequence !== undefined
        ? { lastTransitionSequence: transitionState.lastSequence }
        : {}),
      ...(transitionState?.lastSnapshot
        ? { lastTransitionSnapshot: transitionState.lastSnapshot }
        : {}),
    });
    if (decision && decision.to !== run.desiredMode) {
      await this.requestModeChange(run, decision, snapshot);
    }
    return snapshot;
  }

  private explain(
    run: Run,
    events: Event<unknown>[],
    snapshots: RuntimeSignalSnapshot[],
  ): ModeExplanation {
    const transitions = events
      .filter((event) => event.type === "ModeChanged")
      .map((event) => {
        const data = event.data as {
          from: ExecutionMode;
          to: ExecutionMode;
          reason: string;
          signalSnapshotId?: string;
          enforcement?: { method: ModeEnforcementMethod };
        };
        return {
          from: data.from,
          to: data.to,
          reason: data.reason,
          timestamp: event.timestamp,
          ...(data.signalSnapshotId ? { signalSnapshotId: data.signalSnapshotId } : {}),
          ...(data.enforcement ? { enforcement: data.enforcement.method } : {}),
        };
      });
    const latest = snapshots.at(-1);
    const lastTransition = transitions.at(-1);
    const pending = this.active.get(run.id)?.pendingPolicy;
    return {
      mode: run.effectiveMode,
      desiredMode: run.desiredMode,
      effectiveMode: run.effectiveMode,
      ...(pending
        ? {
            pendingEnforcement: {
              toDesired: pending.decision.to,
              method: pending.method,
              requestedAt: pending.requestedAt,
            },
          }
        : {}),
      reason: lastTransition?.reason ?? "Initial mode selected; no runtime transition has occurred",
      ...(latest ? { latestSnapshotId: latest.id } : {}),
      latestSignals: latest?.signals ?? {},
      timeline: transitions,
    };
  }

  private async requireRun(id: string): Promise<Run> {
    const run = await this.dependencies.store.getRun(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    return run;
  }

  private currentPhase(run: Run, lastEvent?: string): string {
    if (run.verificationState === "VERIFYING") return "Verification";
    if (run.verificationState === "VERIFIED") return "Verified handoff";
    if (run.verificationState === "QUARANTINED") return "Quarantine review";
    if (run.state === "QUEUED") return "Queued";
    if (lastEvent === "ContextBuilt") return "Agent execution";
    if (lastEvent === "DiffCaptured") return "Verification";
    return run.state === "RUNNING" ? "Repository and context" : run.state;
  }
}
