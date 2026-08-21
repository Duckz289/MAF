import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  type AssurancePlan,
  buildAssurancePlan,
  type QualityPreference,
} from "../domain/assurance";
import {
  authorizeSpend,
  type BudgetAllocation,
  type BudgetCategory,
  BudgetExhaustedError,
  type BudgetReservationPolicy,
  computeAllocation,
  defaultBudgetReservationPolicy,
  estimateFromHistory,
  sanitizeReportedCost,
} from "../domain/budget";
import { ProviderCircuitBreaker, ProviderCircuitOpenError } from "../domain/circuit-breaker";
import { deriveDebtDelta } from "../domain/debt";
import {
  assertCiEvidence,
  buildDeliveryHandoff,
  deliveryHandoffDigest,
  deriveDeliveryDecision,
  type CiEvidence,
  type DeliveryDecision,
  type DeliveryHandoff,
} from "../domain/delivery";
import {
  assertHealthSample,
  deriveChangeHealth,
  deriveHealthTrend,
  deriveMaintenanceNeed,
  deriveOperationalHealth,
  deriveStructuralHealth,
  type HealthSample,
  type HealthTrend,
  type MaintenanceNeed,
  type StructuralHealthMetrics,
} from "../domain/health";
import { AdaptiveModeController, type ModeDecision } from "../domain/mode-controller";
import {
  derivePerformancePosture,
  type PerformanceMeasurement,
  type PerformancePostureResult,
} from "../domain/performance";
import {
  deriveResiliencePosture,
  deriveResilienceRelevance,
  type ResilienceMeasurement,
  type ResiliencePostureResult,
} from "../domain/resilience";
import {
  defaultEnforcementPolicy,
  type EnforcementPolicy,
  type PendingModeEnforcement,
  planEnforcement,
} from "../domain/policy-enforcement";
import type {
  AgentAdapter,
  AgentSession,
  CiEvidenceVerifierPort,
  ContextBuilderPort,
  ContextBuildResult,
  PerformanceVerifierPort,
  ProductionFeedbackVerifierPort,
  ProjectBrain,
  RepositoryIndex,
  RepositorySnapshot,
  ResilienceVerifierPort,
  RunStore,
  RuntimeSignalCollector,
  Sandbox,
  SandboxDiff,
  SandboxProvider,
  TelemetrySink,
  VerifierPort,
} from "../domain/ports";
import { projectIdentity } from "../domain/project-identity";
import {
  assertProductionFeedback,
  deriveProductionImpact,
  type ProductionFeedback,
  type ProductionImpact,
} from "../domain/production-feedback";
import { deriveQualityReport, deriveTrustState, type QualityReport } from "../domain/quality";
import {
  AgentReportedFailure,
  buildRecoveryCapsule,
  classifyFailure,
  isAutoRetryable,
  verificationSeverity,
} from "../domain/recovery";
import { buildReviewPrompt, parseReviewVerdict, type ReviewVerdict } from "../domain/review";
import { countCrossModuleEdges, deriveRiskVector, type RiskVector } from "../domain/risk";
import { deriveRuntimeGraph } from "../domain/runtime-graph";
import {
  isSafeCredentialReference,
  redactPatchPreview,
  redactSensitiveData,
  redactSensitiveText,
} from "../domain/security";
import {
  assessStrategy,
  buildRunStrategyObservation,
  deriveStrategyEvidenceBinding,
  selectStrategy,
  strategyAllocationKey,
  strategyObservationBinding,
  type StrategyAssessment,
  type StrategyIdentity,
  type StrategyObservation,
  type StrategyScope,
  type StrategySelection,
} from "../domain/strategy";
import {
  type Artifact,
  type Event,
  type ExecutionMode,
  emptyCost,
  emptyUsage,
  type FailureClassification,
  type ModeEnforcementMethod,
  type PerformanceSpec,
  type RecoveryCapsule,
  type ResilienceSpec,
  type Run,
  type RuntimeSignalSnapshot,
  type RuntimeSignals,
  type Task,
  type Verification,
  type VerificationSpec,
} from "../domain/types";
import { LocalWorktreeSandbox } from "../infrastructure/local-worktree";
import { runProcess } from "../infrastructure/process-utils";
import { extractFileCandidates, findRepositoryFile, normalizeFile } from "./file-candidates";

export interface CreateRunRequest {
  prompt: string;
  repositoryPath: string;
  revision?: string | undefined;
  mode?: ExecutionMode | undefined;
  verification?: VerificationSpec | undefined;
  performance?: PerformanceSpec | undefined;
  resilience?: ResilienceSpec | undefined;
  signals?: RuntimeSignals | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  credentialReferences?: string[] | undefined;
  budget?: { mode: "ADVISORY" | "HARD"; limitUsd: number } | undefined;
  qualityPreference?: QualityPreference | undefined;
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
  operationalStatus:
    | "QUEUED"
    | "RUNNING"
    | "STUCK"
    | "VERIFIED"
    | "ASSURANCE_BLOCKED"
    | "AWAITING_REVIEW"
    | "PAUSED"
    | "FAILED"
    | "CANCELLED";
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
  performanceVerifier?: PerformanceVerifierPort;
  resilienceVerifier?: ResilienceVerifierPort;
  repositoryIndex: RepositoryIndex;
  projectBrain: ProjectBrain;
  contextBuilder: ContextBuilderPort;
  telemetry: TelemetrySink;
  runtimeSignals: RuntimeSignalCollector;
  modeController?: AdaptiveModeController;
  repairPolicy?: Partial<VerificationRepairPolicy>;
  enforcementPolicy?: Partial<EnforcementPolicy>;
  recoveryPolicy?: Partial<RecoveryPolicy>;
  budgetReservationPolicy?: Partial<BudgetReservationPolicy>;
  circuitBreaker?: ProviderCircuitBreaker;
  ciEvidenceVerifier?: CiEvidenceVerifierPort;
  productionFeedbackVerifier?: ProductionFeedbackVerifierPort;
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

export interface RecoveryPolicy {
  /** Bound on automatic new-session retries for auto-retryable failure classes per run. */
  maxRecoveryAttempts: number;
}

export const defaultRecoveryPolicy: RecoveryPolicy = {
  maxRecoveryAttempts: 1,
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
  /** Risk vector + assurance plan the quality gate evaluates this candidate against (M5/M6). */
  assessment: RiskAssessment;
}

/** The (riskVector, assurancePlan) pair assessRisk computes; the diff-stage pair is ground truth. */
interface RiskAssessment {
  riskVector: RiskVector;
  assurancePlan: AssurancePlan;
}

interface ActiveRunState {
  cancelled: boolean;
  sandbox?: Sandbox;
  session?: AgentSession | undefined;
  sessionActive: boolean;
  pendingPolicy?: PendingModeEnforcement | undefined;
  policyRestartsUsed: number;
  recoveryAttemptsUsed: number;
  /** True once any budget authorization check for this run has denied a spend. For telemetry. */
  budgetExhaustedObserved: boolean;
  transitionState: TransitionState;
  /**
   * The single live Run object the execute loop reads and writes. External callers (the
   * transition() API) MUST mutate this same object rather than a fresh store copy: the execute
   * loop periodically calls store.updateRun(run) with its own reference, and a second in-flight
   * writer would otherwise silently revert or race with those writes and desynchronize the
   * persisted state from the enforcement events already appended to the log.
   */
  run: Run;
  /**
   * Aborted by cancel() so in-flight trusted verification subprocesses (M10 resilience scenarios)
   * are killed immediately rather than running to their full timeout after the run is cancelled.
   */
  verificationAbort: AbortController;
}

/** Mutable holder so the current session context can be rebuilt when policy changes. */
interface ContextState {
  current: ContextBuildResult;
  mode: ExecutionMode;
  snapshot: RepositorySnapshot;
  projectId: string;
  /** Frozen pre-execution observation; candidate-driven scope growth cannot impersonate a base change. */
  baselineStructuralHealth: StructuralHealthMetrics;
}

const newTransitionState = (): TransitionState => ({
  count: 0,
  strictReexpansions: 0,
  liveUpdates: 0,
  boundaryEnforcements: 0,
  safeRestarts: 0,
});

/** Failure classes that reflect provider/network health, not agent code quality. */
const providerRelatedClassifications = new Set<FailureClassification>([
  "PROVIDER_TRANSIENT",
  "PROVIDER_DEGRADED",
  "RATE_LIMIT",
  "NETWORK_FAILURE",
]);

const assertPersistenceSafeLocator = (label: string, value: string | undefined): void => {
  if (value !== undefined && redactSensitiveText(value) !== value) {
    throw new Error(
      `${label} contains credential-shaped text and cannot be used as durable execution state`,
    );
  }
};

const assertCredentialReferences = (references: string[]): void => {
  if (references.some((reference) => !isSafeCredentialReference(reference))) {
    throw new Error("Agent credentials must be credential:// references, never raw values");
  }
};

export class RunService {
  private readonly active = new Map<string, ActiveRunState>();
  private readonly modeController: AdaptiveModeController;
  private readonly repairPolicy: VerificationRepairPolicy;
  private readonly enforcementPolicy: EnforcementPolicy;
  private readonly recoveryPolicy: RecoveryPolicy;
  private readonly budgetReservationPolicy: BudgetReservationPolicy;
  private readonly circuitBreaker: ProviderCircuitBreaker;
  /** Blocks new run creation while true (Emergency Stop). Existing evidence is never touched. */
  private emergencyStopped = false;

  constructor(private readonly dependencies: RunServiceDependencies) {
    this.modeController = dependencies.modeController ?? new AdaptiveModeController();
    this.repairPolicy = { ...defaultVerificationRepairPolicy, ...dependencies.repairPolicy };
    this.enforcementPolicy = { ...defaultEnforcementPolicy, ...dependencies.enforcementPolicy };
    this.recoveryPolicy = { ...defaultRecoveryPolicy, ...dependencies.recoveryPolicy };
    this.budgetReservationPolicy = {
      ...defaultBudgetReservationPolicy,
      ...dependencies.budgetReservationPolicy,
    };
    this.circuitBreaker = dependencies.circuitBreaker ?? new ProviderCircuitBreaker();
    if (this.repairPolicy.maxRepairAttempts < 0)
      throw new Error("Maximum repair attempts cannot be negative");
    if (this.enforcementPolicy.maxPolicyRestarts < 0)
      throw new Error("Maximum policy restarts cannot be negative");
    if (this.recoveryPolicy.maxRecoveryAttempts < 0)
      throw new Error("Maximum recovery attempts cannot be negative");
    const shareSum =
      this.budgetReservationPolicy.executionShare +
      this.budgetReservationPolicy.verificationShare +
      this.budgetReservationPolicy.recoveryShare;
    if (Math.abs(shareSum - 1) > 1e-6) throw new Error("Budget reservation shares must sum to 1");
  }

  async create(request: CreateRunRequest): Promise<Run> {
    if (this.emergencyStopped) {
      throw new Error("New runs are blocked: an emergency stop is active");
    }
    const resolvedRepositoryPath = path.resolve(request.repositoryPath);
    const requestedRevision = request.revision ?? "HEAD";
    assertPersistenceSafeLocator("Repository path", resolvedRepositoryPath);
    assertPersistenceSafeLocator("Revision", requestedRevision);
    assertPersistenceSafeLocator("Expected-file path", request.verification?.expectedFile);
    assertCredentialReferences(request.credentialReferences ?? []);
    const now = new Date().toISOString();
    const task: Task = {
      id: crypto.randomUUID(),
      prompt: request.prompt,
      repositoryPath: resolvedRepositoryPath,
      revision: requestedRevision,
      createdAt: now,
      verification: request.verification ?? {},
      ...(request.performance ? { performance: request.performance } : {}),
      ...(request.resilience ? { resilience: request.resilience } : {}),
      ...(request.signals ? { signals: request.signals } : {}),
      ...(request.budget ? { budget: request.budget } : {}),
      ...(request.qualityPreference ? { qualityPreference: request.qualityPreference } : {}),
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
      agent: redactSensitiveText(request.agent ?? this.dependencies.agent.name),
      model: redactSensitiveText(request.model ?? "native"),
      provider: redactSensitiveText(request.provider ?? "native"),
      createdAt: now,
      updatedAt: now,
      changedFiles: [],
      cost: emptyCost(),
      usage: emptyUsage(),
      retryCount: 0,
    };
    // Execution keeps the caller's in-memory task, but durable/API-facing task text is sanitized.
    // A resumed run intentionally receives the sanitized form: raw credentials are not durable
    // execution state and must not be reintroduced from storage.
    await this.dependencies.store.createTask({
      ...task,
      prompt: redactSensitiveText(task.prompt),
      verification: {
        ...task.verification,
        ...(task.verification.command
          ? { command: redactSensitiveText(task.verification.command) }
          : {}),
        ...(task.verification.expectedFile
          ? { expectedFile: redactSensitiveText(task.verification.expectedFile) }
          : {}),
      },
      ...(task.performance
        ? {
            performance: {
              ...task.performance,
              command: redactSensitiveText(task.performance.command),
              metric: redactSensitiveText(task.performance.metric),
              ...(task.performance.unit
                ? { unit: redactSensitiveText(task.performance.unit) }
                : {}),
            },
          }
        : {}),
      ...(task.resilience
        ? {
            resilience: {
              ...task.resilience,
              command: redactSensitiveText(task.resilience.command),
              ...(task.resilience.evidenceInputs
                ? {
                    evidenceInputs: task.resilience.evidenceInputs.map((input) =>
                      redactSensitiveText(input),
                    ),
                  }
                : {}),
              ...(task.resilience.composeFile
                ? { composeFile: redactSensitiveText(task.resilience.composeFile) }
                : {}),
            },
          }
        : {}),
    });
    await this.dependencies.store.createRun(run);
    await this.event(run.id, "RunCreated", {
      taskId: task.id,
      executionMode: run.executionMode,
      agent: run.agent,
      model: run.model,
    });
    const allocation = computeAllocation(
      task.budget ?? { mode: "ADVISORY", limitUsd: null },
      this.budgetReservationPolicy,
    );
    await this.event(run.id, "BudgetAllocated", {
      mode: task.budget?.mode ?? "ADVISORY",
      configured: task.budget !== undefined,
      allocation,
    });
    // A bounded range anchored to prior verified-success cost, never a fabricated point figure;
    // genuinely null (not $0) when no telemetry history exists yet to anchor it to.
    const costEstimate = estimateFromHistory(
      await this.dependencies.telemetry.costPerVerifiedSuccess(),
    );
    await this.event(run.id, "CostEstimated", { estimate: costEstimate });
    this.active.set(run.id, {
      cancelled: false,
      sessionActive: false,
      policyRestartsUsed: 0,
      recoveryAttemptsUsed: 0,
      budgetExhaustedObserved: false,
      transitionState: newTransitionState(),
      run,
      verificationAbort: new AbortController(),
    });
    // Re-check immediately before starting execution, with no `await` in between: an emergency
    // stop synchronously iterates `this.active` the instant it is called, so a stop that lands
    // while this method was suspended on the awaits above (before the run existed in `this.active`
    // to be swept up) would otherwise let a "new agent" start after the operator was told the stop
    // had already taken effect. This closes that window without needing any lock.
    if (this.emergencyStopped) {
      await this.cancel(run.id);
      // execute() never ran, so its finally block (the only other place that clears an entry)
      // never will either — clear it here or this run would leak in `this.active` forever and
      // waitForIdle() would hang on it indefinitely.
      this.active.delete(run.id);
      return structuredClone(run);
    }
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
          run.verificationState === "VERIFIED" && run.trustState === "MERGE_ELIGIBLE"
            ? "VERIFIED"
            : run.verificationState === "VERIFIED" &&
                (run.trustState === "QUALITY_VERIFIED" || run.trustState === "DURABLE_VERIFIED")
              ? "AWAITING_REVIEW"
              : run.verificationState === "VERIFIED"
                ? "ASSURANCE_BLOCKED"
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

  async delivery(id: string): Promise<DeliveryDecision | undefined> {
    await this.requireRun(id);
    const handoff = await this.dependencies.store.getDeliveryHandoff(id);
    if (!handoff) return undefined;
    const ciEvidence = await this.dependencies.store.listCiEvidence(handoff.id);
    return deriveDeliveryDecision(handoff, ciEvidence);
  }

  async collectCiEvidence(
    id: string,
    input: { provider: string; externalRunId: string },
  ): Promise<DeliveryDecision> {
    await this.requireRun(id);
    const handoff = await this.dependencies.store.getDeliveryHandoff(id);
    if (!handoff) throw new Error(`Run ${id} has no verified delivery handoff`);
    const verifier = this.dependencies.ciEvidenceVerifier;
    if (!verifier) {
      const error = new Error("No trusted external CI evidence verifier is configured") as Error & {
        statusCode: number;
      };
      error.statusCode = 501;
      throw error;
    }
    const collected = await verifier.collect({ handoff, ...input });
    const evidence: CiEvidence = {
      ...collected,
      schemaVersion: 1,
      id: crypto.randomUUID(),
      handoffId: handoff.id,
    };
    assertCiEvidence(evidence);
    if (
      evidence.provider !== input.provider ||
      evidence.externalRunId !== input.externalRunId ||
      evidence.candidateId !== handoff.candidateId ||
      evidence.candidateDigest !== handoff.candidateDigest ||
      evidence.baseRevision !== handoff.baseRevision ||
      (handoff.headRevision !== null && evidence.headRevision !== handoff.headRevision)
    ) {
      throw new Error("Trusted CI response is stale or references a different candidate");
    }
    await this.dependencies.store.saveCiEvidence(evidence);
    return deriveDeliveryDecision(
      handoff,
      await this.dependencies.store.listCiEvidence(handoff.id),
    );
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
    active.verificationAbort.abort();
    await this.dependencies.verifier.cancel(id);
    run.state = "CANCELLED";
    run.verificationState = "CANCELLED";
    run.updatedAt = new Date().toISOString();
    run.completedAt = run.updatedAt;
    await this.dependencies.store.updateRun(run);
    await this.event(id, "RunCancelled", {});
    return structuredClone(run);
  }

  /**
   * Explicitly resumes a PAUSED run from its durable RecoveryCapsule. Detects revision conflict
   * (M3C) before trusting prior evidence: the sandbox worktree stays frozen at whatever commit it
   * was created from, so the conflict to detect is the SOURCE repository's target revision (e.g.
   * a floating "HEAD") moving on while the run was paused — comparing the frozen worktree to
   * itself would never observe that drift.
   */
  async resume(id: string, credentialReferences: string[] = []): Promise<Run> {
    if (this.emergencyStopped) {
      throw new Error("Cannot resume runs: an emergency stop is active");
    }
    assertCredentialReferences(credentialReferences);
    const run = await this.requireRun(id);
    if (run.state !== "PAUSED") throw new Error(`Run ${id} is not paused (state: ${run.state})`);
    const capsule = await this.dependencies.store.getRecoveryCapsule(id);
    if (!capsule) throw new Error(`No recovery capsule is stored for run ${id}`);
    const task = await this.dependencies.store.getTask(run.taskId);
    if (!task) throw new Error(`Unknown task for run ${id}`);
    if (!capsule.workspacePath) {
      throw new Error(`Recovery capsule for run ${id} has no preserved workspace to resume`);
    }
    if (!existsSync(capsule.workspacePath)) {
      // Most commonly SANDBOX_RETENTION=none, which deletes every sandbox on cleanup regardless
      // of outcome — the recovery plane requires a non-"none" retention policy to be meaningful.
      // Fail with a clear, specific cause rather than an opaque filesystem/git error deep inside
      // the next execute() attempt.
      throw new Error(
        `Cannot resume run ${id}: the preserved workspace ${capsule.workspacePath} no longer ` +
          "exists. This usually means SANDBOX_RETENTION=none, which deletes every sandbox " +
          "regardless of outcome and is incompatible with resuming a paused run.",
      );
    }
    const currentSourceRevision = await this.resolveRevision(
      capsule.repositoryPath,
      capsule.requestedRevision,
    );
    if (capsule.resolvedRevision === undefined || currentSourceRevision === undefined) {
      // Unknown stays unknown: an inconclusive check (a transient git failure at capture or
      // resume time) must never be silently treated as "no conflict" — that is exactly the
      // "blindly resume on stale ground" failure mode M3C exists to prevent.
      await this.event(id, "ResumeRefused", {
        reason: "REVISION_UNKNOWN",
        capsuleRevisionKnown: capsule.resolvedRevision !== undefined,
        currentRevisionKnown: currentSourceRevision !== undefined,
      });
      throw new Error(
        `Refusing to resume run ${id}: could not verify whether the repository's ` +
          `${capsule.requestedRevision} has changed since the capsule was captured`,
      );
    }
    if (capsule.resolvedRevision !== currentSourceRevision) {
      await this.event(id, "ResumeRefused", {
        reason: "REVISION_CONFLICT",
        capsuleRevision: capsule.resolvedRevision,
        currentSourceRevision,
      });
      throw new Error(
        `Refusing to resume run ${id}: the repository's ${capsule.requestedRevision} moved from ` +
          `${capsule.resolvedRevision} to ${currentSourceRevision} while this run was paused`,
      );
    }
    const sandbox: Sandbox = {
      id: run.id,
      path: capsule.workspacePath,
      repositoryPath: capsule.repositoryPath,
      revision: capsule.requestedRevision,
    };
    run.state = "RUNNING";
    run.updatedAt = new Date().toISOString();
    await this.dependencies.store.updateRun(run);
    this.active.set(run.id, {
      cancelled: false,
      sessionActive: false,
      policyRestartsUsed: 0,
      recoveryAttemptsUsed: 0,
      budgetExhaustedObserved: false,
      transitionState: newTransitionState(),
      run,
      verificationAbort: new AbortController(),
    });
    // Same closed-window re-check as create(): no `await` between here and kicking off execute().
    if (this.emergencyStopped) {
      await this.cancel(run.id);
      this.active.delete(run.id);
      return structuredClone(run);
    }
    void this.execute(run, task, credentialReferences, sandbox);
    return structuredClone(run);
  }

  async recoveryCapsule(id: string): Promise<RecoveryCapsule | undefined> {
    await this.requireRun(id);
    return this.dependencies.store.getRecoveryCapsule(id);
  }

  /**
   * M11 codebase health ledger: the most recent samples plus the trend between the last two
   * consecutive samples and the maintenance-mission proposal derived from it. Trend and
   * maintenance are absent when fewer than two samples exist — a single sample is a baseline,
   * not a trend, and unknown stays unknown.
   */
  async healthLedger(projectId?: string): Promise<{
    samples: HealthSample[];
    trend?: HealthTrend;
    maintenance?: MaintenanceNeed;
    productionImpact: ProductionImpact;
  }> {
    let samples = await this.dependencies.store.listHealthSamples(projectId, 20);
    let selectedProjectId = projectId;
    if (projectId === undefined) {
      const latestProjectId = samples.at(-1)?.projectId;
      if (latestProjectId !== undefined) {
        selectedProjectId = latestProjectId;
        samples = await this.dependencies.store.listHealthSamples(latestProjectId, 20);
      }
    }
    const feedback = selectedProjectId
      ? await this.dependencies.store.listProductionFeedback(selectedProjectId, 100)
      : [];
    const productionImpact = deriveProductionImpact(feedback);
    if (samples.length < 2) return { samples, productionImpact };
    const [previous, current] = samples.slice(-2);
    if (!previous || !current) return { samples, productionImpact };
    const trend = deriveHealthTrend(previous, current);
    return { samples, trend, maintenance: deriveMaintenanceNeed(trend), productionImpact };
  }

  /** Read only store-bound production observations; benchmark shadow evidence is report-local. */
  async strategyAssessment(
    scope: StrategyScope,
    challenger: StrategyIdentity,
  ): Promise<StrategyAssessment & { productionImpact: ProductionImpact }> {
    const observations = await this.dependencies.store.listStrategyObservations(scope.projectId);
    const assessment = assessStrategy(scope, challenger, observations);
    const relevant = (await this.dependencies.store.listProductionFeedback(scope.projectId)).filter(
      (item) =>
        isDeepStrictEqual(item.scope, scope) && isDeepStrictEqual(item.strategy, challenger),
    );
    const productionImpact = deriveProductionImpact(relevant);
    return productionImpact.strategyDemotionRequired
      ? {
          ...assessment,
          lifecycle: "DEMOTED",
          reasons: [...assessment.reasons, ...productionImpact.reasons],
          productionImpact,
        }
      : { ...assessment, productionImpact };
  }

  async productionFeedback(projectId: string): Promise<{
    feedback: ProductionFeedback[];
    impact: ProductionImpact;
  }> {
    const feedback = await this.dependencies.store.listProductionFeedback(projectId, 100);
    return { feedback, impact: deriveProductionImpact(feedback) };
  }

  async collectProductionFeedback(input: {
    provider: string;
    externalEventId: string;
  }): Promise<ProductionFeedback> {
    const verifier = this.dependencies.productionFeedbackVerifier;
    if (!verifier) {
      const error = new Error("No trusted production feedback verifier is configured") as Error & {
        statusCode: number;
      };
      error.statusCode = 501;
      throw error;
    }
    const collected = await verifier.collect(input);
    const feedback: ProductionFeedback = {
      ...collected,
      schemaVersion: 1,
      id: crypto.randomUUID(),
    };
    assertProductionFeedback(feedback);
    if (
      feedback.source.provider !== input.provider ||
      feedback.source.externalEventId !== input.externalEventId
    )
      throw new Error("Trusted production source returned a different external event identity");
    await this.dependencies.store.saveProductionFeedback(feedback);
    return feedback;
  }

  async selectExecutionStrategy(
    scope: StrategyScope,
    nativeFrontier: StrategyIdentity,
    challenger: StrategyIdentity,
  ): Promise<StrategySelection> {
    const observations = await this.dependencies.store.listStrategyObservations(scope.projectId);
    const initial = selectStrategy(scope, nativeFrontier, challenger, observations, 1);
    const productionImpact = deriveProductionImpact(
      (await this.dependencies.store.listProductionFeedback(scope.projectId)).filter(
        (item) =>
          isDeepStrictEqual(item.scope, scope) && isDeepStrictEqual(item.strategy, challenger),
      ),
    );
    if (productionImpact.strategyDemotionRequired)
      return {
        selected: nativeFrontier,
        challenger: {
          ...initial.challenger,
          lifecycle: "DEMOTED",
          reasons: [...initial.challenger.reasons, ...productionImpact.reasons],
        },
        reason: "trusted production feedback demoted the challenger; native frontier selected",
      };
    if (initial.challenger.lifecycle !== "CANARY") return initial;
    const canaryOrdinal = await this.dependencies.store.allocateStrategyCanaryOrdinal(
      strategyAllocationKey(scope, challenger),
    );
    return selectStrategy(scope, nativeFrontier, challenger, observations, canaryOrdinal);
  }

  /**
   * Cancels every active run and blocks new run creation until resumeNewRuns() is called, while
   * preserving worktrees, checkpoints, evidence, and candidate lineage. Never deletes anything —
   * emergency stop is a pause, not a wipe. Cancellation is bounded by the same guarantee cancel()
   * already has: a session already inside agent.start()/send() (before any event has arrived)
   * finishes that call before the cancellation is observed and acted on in the event loop; it is
   * not a hard kill of an in-flight provider request.
   */
  async emergencyStop(): Promise<{ cancelledRunIds: string[] }> {
    this.emergencyStopped = true;
    const cancelledRunIds: string[] = [];
    for (const id of [...this.active.keys()]) {
      await this.cancel(id);
      cancelledRunIds.push(id);
    }
    return { cancelledRunIds };
  }

  resumeNewRuns(): void {
    this.emergencyStopped = false;
  }

  isEmergencyStopped(): boolean {
    return this.emergencyStopped;
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
      // Operator-provided transition rationale is durable evidence and eventually appears in the
      // ModeChanged event produced by the controller. Sanitize it before it enters the decision,
      // in addition to sanitizing the final event at the persistence boundary below.
      reason: redactSensitiveText(reason),
      evidence: redactSensitiveData({ ...evidence, source: "EXTERNAL_HINT" }) as Record<
        string,
        unknown
      >,
    });
    return structuredClone(run);
  }

  private async execute(
    run: Run,
    task: Task,
    credentialReferences: string[],
    resumeSandbox?: Sandbox,
  ): Promise<void> {
    const started = performance.now();
    const initialMode = run.effectiveMode;
    const activeState = this.active.get(run.id);
    const transitionState = activeState?.transitionState ?? newTransitionState();
    let modelCostReported = false;
    let sandbox: Sandbox | undefined;
    try {
      run.state = "RUNNING";
      run.startedAt = run.startedAt ?? new Date().toISOString();
      run.updatedAt = new Date().toISOString();
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, resumeSandbox ? "RunResumed" : "RunStarted", {});

      const preparedSandbox =
        resumeSandbox ??
        (await this.dependencies.sandbox.create(run.id, task.repositoryPath, task.revision));
      assertPersistenceSafeLocator("Sandbox path", preparedSandbox.path);
      assertPersistenceSafeLocator("Sandbox revision", preparedSandbox.revision);
      sandbox = preparedSandbox;
      const active = this.active.get(run.id);
      if (active) active.sandbox = sandbox;
      run.sandboxPath = sandbox.path;
      await this.dependencies.store.updateRun(run);
      if (!resumeSandbox) {
        await this.event(run.id, "SandboxStarted", {
          provider: "LocalWorktree",
          path: sandbox.path,
          revision: sandbox.revision,
        });
      }

      await this.dependencies.projectBrain.markStale(task.repositoryPath, task.revision);
      // Cheap full pass: file list plus path-derived package/module ownership, no content read.
      const cheapSnapshot = await this.dependencies.repositoryIndex.index(
        sandbox.path,
        task.revision,
      );
      // Selecting scope needs only moduleMap/paths, not symbols, so this first build is cheap.
      const scope = await this.dependencies.contextBuilder.build({
        task,
        mode: run.effectiveMode,
        snapshot: cheapSnapshot,
        projectId: task.repositoryPath,
      });
      const enrichedSnapshot = await this.dependencies.repositoryIndex.indexScope(
        sandbox.path,
        task.revision,
        cheapSnapshot,
        scope.initialFiles,
      );
      // Re-render with the now-parsed initial scope so the context text carries real symbols.
      const context = await this.dependencies.contextBuilder.build({
        task,
        mode: run.effectiveMode,
        snapshot: enrichedSnapshot,
        projectId: task.repositoryPath,
      });
      const contextState: ContextState = {
        current: context,
        mode: run.effectiveMode,
        snapshot: enrichedSnapshot,
        projectId: task.repositoryPath,
        baselineStructuralHealth: deriveStructuralHealth(enrichedSnapshot),
      };
      await this.event(run.id, "ContextBuilt", {
        tokenEstimate: context.tokenEstimate,
        evidenceIds: context.evidenceIds,
        modules: Object.keys(enrichedSnapshot.moduleMap).length,
        symbols: enrichedSnapshot.symbols.length,
        initialFiles: context.initialFiles,
        initialModules: context.initialModules,
        filesTruncated: enrichedSnapshot.filesTruncated,
        scopeTruncated: enrichedSnapshot.scopeTruncated,
      });
      // Pre-execution estimate: the only thing available before any diff exists. Refined once a
      // candidate's actual diff exists (see captureCandidate) — see the M5 design note.
      const preExecutionAssessment = await this.assessRisk(
        run,
        task,
        enrichedSnapshot,
        context.initialFiles,
        "pre-execution",
      );

      // The collector rejects re-initializing a run it already has state for (an invariant, not
      // an oversight — see EvidenceRuntimeSignalCollector.observe). A same-process resume shares
      // the same collector instance and therefore already has state from before the pause; only
      // a genuinely fresh run (or a resume in a fresh process, where nothing has been observed
      // yet) needs INITIAL_CONTEXT. Checking "does state already exist" rather than a resume-only
      // flag also means this stays correct in either case.
      const existingSignalState = await this.dependencies.runtimeSignals.latest(run.id);
      if (!existingSignalState) {
        await this.observeAndDecide(run, {
          runId: run.id,
          type: "INITIAL_CONTEXT",
          timestamp: new Date().toISOString(),
          checkpoint: "context-built",
          repository: enrichedSnapshot,
          initialFiles: context.initialFiles,
          initialModules: context.initialModules,
          ...(task.signals ? { externalHints: task.signals } : {}),
        });
      }

      const securityBoundary = await this.dependencies.agent.securityBoundary?.();
      if (securityBoundary) await this.event(run.id, "AgentSecurityBoundary", securityBoundary);
      const capabilities = await this.dependencies.agent.capabilities();
      await this.refreshContext(run, task, sandbox, contextState);

      const allocation = computeAllocation(
        task.budget ?? { mode: "ADVISORY", limitUsd: null },
        this.budgetReservationPolicy,
      );
      const budgetMode = task.budget?.mode ?? "ADVISORY";
      this.requireExecutionBudget(run, allocation, budgetMode, "before starting the first session");

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
      let qualityReport: QualityReport | undefined;
      let strategyObservation: StrategyObservation | undefined;
      let deliveryHandoff: DeliveryHandoff | undefined;

      for (;;) {
        candidate = await this.captureCandidate(
          run,
          task,
          sandbox,
          contextState,
          verificationAttempts + 1,
          parentCandidateId,
          preExecutionAssessment,
        );
        verificationAttempts += 1;
        run.verificationState = "VERIFYING";
        await this.dependencies.store.updateRun(run);
        await this.event(run.id, "VerificationChanged", {
          state: "VERIFYING",
          attempt: verificationAttempts,
          candidateId: candidate.id,
        });
        // Deliberately unconditional: M4C requires budget to never silently reduce required
        // trust, so verification always runs regardless of the "verification" reserve's state —
        // there is no budget gate here, by design. (The current CommandVerifier is $0 per run
        // either way; the "verification" allocation exists for a future costed verifier, at which
        // point this comment is the reminder that it still must never be skipped for budget.)
        const verifierResult = await this.dependencies.verifier.verify(
          run,
          task,
          sandbox,
          candidate.diff,
        );
        verification = {
          ...verifierResult,
          ...(verifierResult.command
            ? { command: redactSensitiveText(verifierResult.command) }
            : {}),
          output: redactSensitiveText(verifierResult.output),
          attempt: verificationAttempts,
          candidateId: candidate.id,
        };
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
          verificationSeverity(verification) > verificationSeverity(previousVerification);
        const repairAuthorization = authorizeSpend(
          allocation,
          this.spentByCategory(run),
          "execution",
          budgetMode,
        );
        if (
          repairAttempts >= this.repairPolicy.maxRepairAttempts ||
          worseState ||
          !repairAuthorization.authorized
        ) {
          if (!repairAuthorization.authorized) {
            const active = this.active.get(run.id);
            if (active) active.budgetExhaustedObserved = true;
          }
          // Budget may reduce scope (stop repairing here) but must never silently upgrade this
          // candidate's trust — the last verification result stands exactly as it is.
          await this.event(run.id, "VerificationRepairStopped", {
            reason: !repairAuthorization.authorized
              ? "budget-exhausted"
              : worseState
                ? "verification-state-worsened"
                : "repair-limit-reached",
            verificationAttempts,
            repairAttempts,
            maxRepairAttempts: this.repairPolicy.maxRepairAttempts,
            candidateId: candidate.id,
            ...(!repairAuthorization.authorized ? { budget: repairAuthorization } : {}),
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
        await this.refreshContext(run, task, sandbox, contextState);
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
      // M6 quality gate: after the correctness gate has spoken, evaluate the candidate's quality
      // dimensions and derive its trust state. Only a VERIFIED candidate is assessed -- the gate
      // distinguishes correctness from quality, it never replaces or overrides the correctness
      // gate's verdict.
      if (verification.state === "VERIFIED" && candidate) {
        qualityReport = await this.assessQuality(
          run,
          task,
          sandbox,
          contextState,
          candidate,
          verification,
          context.initialModules,
          preExecutionAssessment,
        );
      } else {
        // A candidate whose deterministic verification did not pass stays PROPOSED — no model
        // review is consulted (let alone able to lift it), because deterministic evidence
        // outranks model confidence.
        run.trustState = "PROPOSED";
      }
      if (candidate) {
        run.strategyEvidenceBinding = deriveStrategyEvidenceBinding(
          projectIdentity(task.repositoryPath),
          task,
          candidate.assessment.riskVector,
          candidate.assessment.assurancePlan.required,
        );
      }
      if (this.active.get(run.id)?.cancelled) {
        throw new Error("Run cancelled during quality assurance");
      }
      run.verificationState = verification.state;
      run.state = verification.state === "VERIFIED" ? "COMPLETED" : "FAILED";
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      if (candidate) {
        const change = deriveChangeHealth(candidate.diff.patch);
        const deterioration =
          change.architectureViolations +
          change.unsafeTypeEscapes +
          change.skippedTests +
          change.duplicatedBlocks;
        strategyObservation = buildRunStrategyObservation({
          id: crypto.randomUUID(),
          timestamp: run.completedAt,
          run,
          task,
          projectId: projectIdentity(task.repositoryPath),
          candidate: candidate.artifact,
          riskVector: candidate.assessment.riskVector,
          requiredChecks: candidate.assessment.assurancePlan.required,
          ...(qualityReport ? { qualityReport } : {}),
          costKnown: modelCostReported,
          latencyMs: performance.now() - started,
          healthEffect:
            verification.state !== "VERIFIED" || !change.changeEvidenceComplete
              ? "UNKNOWN"
              : deterioration > 0
                ? "DEGRADING"
                : "STABLE",
        });
        run.strategyObservationBinding = strategyObservationBinding(strategyObservation);
      }
      if (candidate && qualityReport && verification.state === "VERIFIED") {
        deliveryHandoff = buildDeliveryHandoff({
          id: crypto.randomUUID(),
          projectId: projectIdentity(task.repositoryPath),
          run,
          task,
          candidate: candidate.artifact,
          verification,
          qualityReport,
          riskVector: candidate.assessment.riskVector,
        });
        run.deliveryHandoffBinding = {
          handoffId: deliveryHandoff.id,
          candidateId: deliveryHandoff.candidateId,
          candidateDigest: deliveryHandoff.candidateDigest,
          payloadDigest: deliveryHandoffDigest(deliveryHandoff),
        };
      }
      await this.dependencies.store.updateRun(run);
      await this.event(run.id, "RunCompleted", {
        state: run.state,
        verificationState: run.verificationState,
        trustState: run.trustState ?? null,
        verificationAttempts,
        repairAttempts,
      });
      const healthProjectId = projectIdentity(task.repositoryPath);
      try {
        const latestSignals = await this.dependencies.runtimeSignals.latest(run.id);
        const signalValues = latestSignals?.signals;
        await this.dependencies.telemetry.record({
          taskId: task.id,
          runId: run.id,
          projectId: healthProjectId,
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
          budgetMode: task.budget?.mode ?? "ADVISORY",
          budgetLimitUsd: task.budget?.limitUsd ?? null,
          budgetExhausted: this.active.get(run.id)?.budgetExhaustedObserved ?? false,
          timestamp: run.completedAt,
        });
      } catch (telemetryError) {
        await this.event(run.id, "TelemetryFailed", {
          error: telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
        });
      }
      // M11 health ledger: only a trusted-verifier candidate becomes longitudinal evidence. This
      // is explicitly a VERIFIED_CANDIDATE observation, not a claim that the candidate was merged
      // or deployed. Failed/quarantined candidates remain in their existing run evidence only.
      if (verification.state !== "VERIFIED" || !candidate) {
        await this.event(run.id, "HealthSampleSkipped", {
          reason: "only a candidate that passed the trusted verifier can enter the health ledger",
          verificationState: verification.state,
        });
      } else {
        try {
          const operationalRecords = this.dependencies.telemetry.listRecords
            ? await this.dependencies.telemetry.listRecords(50, healthProjectId)
            : [];
          const operational = deriveOperationalHealth(operationalRecords);
          const resolvedRevision = candidate.artifact.metadata.baseRevision;
          const candidateDigest = candidate.artifact.digest;
          if (typeof resolvedRevision !== "string" || !candidateDigest) {
            throw new Error(
              "Verified candidate health evidence lacks a resolved revision or digest",
            );
          }
          const sample: HealthSample = {
            projectId: healthProjectId,
            revision: resolvedRevision,
            timestamp: run.completedAt ?? new Date().toISOString(),
            runId: run.id,
            candidateId: candidate.id,
            candidateDigest,
            evidenceBasis: "VERIFIED_CANDIDATE",
            structuralBasis: "BASE_REVISION",
            changeBasis: "VERIFIED_CANDIDATE_DIFF",
            structural: contextState.baselineStructuralHealth,
            change: deriveChangeHealth(candidate.diff.patch),
            ...(operational ? { operational } : {}),
          };
          const sanitizedSample: unknown = redactSensitiveData(sample);
          assertHealthSample(sanitizedSample);
          await this.dependencies.store.saveHealthSample(sanitizedSample);
        } catch (healthError) {
          await this.event(run.id, "HealthSampleFailed", {
            error: healthError instanceof Error ? healthError.message : String(healthError),
          });
        }
      }
      // M12 production strategy evidence is derived here, after the run has reached COMPLETED and
      // the quality vector is final. The store independently re-binds it to the verified candidate.
      if (strategyObservation) {
        try {
          await this.dependencies.store.saveStrategyObservation(strategyObservation);
        } catch (strategyError) {
          await this.event(run.id, "StrategyObservationFailed", {
            error: strategyError instanceof Error ? strategyError.message : String(strategyError),
          });
        }
      }
      // M13: immutable delivery evidence is created only for the final VERIFIED candidate. CI is
      // intentionally absent here; an external verifier port must collect that evidence later.
      if (deliveryHandoff) {
        try {
          await this.dependencies.store.saveDeliveryHandoff(deliveryHandoff);
          await this.event(run.id, "DeliveryHandoffCreated", {
            handoffId: deliveryHandoff.id,
            candidateId: deliveryHandoff.candidateId,
            candidateDigest: deliveryHandoff.candidateDigest,
            ciStatus: "NOT_CHECKED",
            mergeAuthority: "EXTERNAL_APPROVAL_REQUIRED",
          });
        } catch (deliveryError) {
          await this.event(run.id, "DeliveryHandoffFailed", {
            error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
          });
        }
      }
    } catch (error) {
      const latest = await this.dependencies.store.getRun(run.id);
      if (latest?.state !== "CANCELLED") {
        run.verificationState = run.verificationState === "VERIFYING" ? "QUARANTINED" : "FAILED";
        const rawErrorDetail = error instanceof Error ? error.message : String(error);
        const classification = classifyFailure(error, {
          agentReported: error instanceof AgentReportedFailure,
          budgetExhausted: error instanceof BudgetExhaustedError,
          circuitOpen: error instanceof ProviderCircuitOpenError,
        });
        run.error = redactSensitiveText(rawErrorDetail);
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        try {
          const capsule = await this.captureRecoveryCapsule(
            run,
            task,
            sandbox,
            classification,
            run.error,
          );
          await this.dependencies.store.saveRecoveryCapsule(capsule);
          run.state = "PAUSED";
          await this.dependencies.store.updateRun(run);
          await this.event(run.id, "RunPaused", {
            recoveryReason: classification,
            error: run.error,
            strongestCandidateId: capsule.strongestCandidateId ?? null,
            workspacePreserved: Boolean(sandbox),
          });
        } catch (capsuleError) {
          // Capsule-building is the last resort's last resort — if even that fails, fall back to
          // a bare FAILED rather than claim PAUSED (resumable) without any recovery evidence.
          run.state = "FAILED";
          await this.dependencies.store.updateRun(run);
          await this.event(run.id, "RunFailed", {
            error: run.error,
            recoveryCapsuleError:
              capsuleError instanceof Error ? capsuleError.message : String(capsuleError),
          });
        }
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
    let result = await this.runAgentAttemptWithRecovery(
      run,
      task,
      sandbox,
      contextState,
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
      await this.refreshContext(run, task, sandbox, contextState);
      // Preserve whatever the interrupted session was actually working on — the original task on
      // a first attempt, or the verifier repair instructions if this restart interrupted a bounded
      // repair. Always falling back to task.prompt would silently discard repair evidence and
      // waste the bounded repair attempt the session was mid-way through.
      const continuation = [
        `Execution policy changed to ${run.effectiveMode}: ${pending.decision.reason}.`,
        "policy-restart-continuation: continue the interrupted work in the same workspace.",
        message,
      ].join("\n");
      result = await this.runAgentAttemptWithRecovery(
        run,
        task,
        sandbox,
        contextState,
        credentialReferences,
        continuation,
      );
      modelCostReported ||= result.modelCostReported;
    }
    await this.applyPendingAtBoundary(run, "agent-session-ended");
    return { session: result.session, modelCostReported };
  }

  /**
   * Wraps a single agent attempt with bounded automatic recovery. Only failure classes with a
   * real chance of succeeding on retry without new input (provider hiccups, transient network
   * failures, an agent process that crashed) are retried, and only up to `maxRecoveryAttempts`
   * per run — everything else propagates so execute()'s outer catch can build a durable
   * RecoveryCapsule and pause the run for explicit resume rather than spending budget on a retry
   * that will not fix the underlying cause. A retry always starts a brand-new session; resuming
   * into a session that just failed would carry forward whatever caused the failure.
   */
  private async runAgentAttemptWithRecovery(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
    credentialReferences: string[],
    message: string,
    resumeFrom?: AgentSession,
  ): Promise<{ session: AgentSession; modelCostReported: boolean; restartRequested: boolean }> {
    const allocation = computeAllocation(
      task.budget ?? { mode: "ADVISORY", limitUsd: null },
      this.budgetReservationPolicy,
    );
    const budgetMode = task.budget?.mode ?? "ADVISORY";
    let attemptResumeFrom = resumeFrom;
    // The first attempt is whatever the caller requested (initial session, repair, or a policy
    // restart continuation) and its cost lands in "execution". Any FURTHER attempt within this
    // same call only happens because a bounded recovery retry was decided below, so its cost is
    // real recovery spend and must land in the "recovery" category the reservation protects.
    let costCategory: BudgetCategory = "execution";
    for (;;) {
      // Refuse before even trying an obviously failing provider, rather than calling it again.
      if (!this.circuitBreaker.canAttempt(run.provider)) {
        throw new ProviderCircuitOpenError(
          `Provider circuit is open for ${run.provider}: too many consecutive failures`,
        );
      }
      if (this.circuitBreaker.state(run.provider) === "HALF_OPEN") {
        this.circuitBreaker.beginAttempt(run.provider);
      }
      try {
        const result = await this.runAgentAttempt(
          run,
          task,
          sandbox,
          contextState,
          credentialReferences,
          message,
          attemptResumeFrom,
          costCategory,
        );
        this.circuitBreaker.recordOutcome(run.provider, true);
        return result;
      } catch (error) {
        // A circuit-open refusal is never itself worth retrying — the very next loop iteration
        // would hit the identical refusal, since nothing about the provider has changed. It was
        // never a real attempt, so there is no probe slot to release either.
        if (error instanceof ProviderCircuitOpenError) throw error;
        const active = this.active.get(run.id);
        if (active?.cancelled) throw error;
        const classification = classifyFailure(error, {
          agentReported: error instanceof AgentReportedFailure,
        });
        // Provider health tracks provider/network-shaped failures specifically, not agent-code
        // quality or verification outcomes — those are different concerns with different owners.
        // Every attempt must resolve its HALF_OPEN probe slot one way or the other (recordOutcome
        // or releaseProbe) — leaving it consumed forever would permanently wedge the circuit open.
        if (providerRelatedClassifications.has(classification)) {
          this.circuitBreaker.recordOutcome(run.provider, false);
        } else {
          this.circuitBreaker.releaseProbe(run.provider);
        }
        const budgetAuthorization = authorizeSpend(
          allocation,
          this.spentByCategory(run),
          "recovery",
          budgetMode,
        );
        if (!active || active.cancelled) throw error;
        if (!isAutoRetryable(classification)) throw error;
        if (active.recoveryAttemptsUsed >= this.recoveryPolicy.maxRecoveryAttempts) throw error;
        if (!budgetAuthorization.authorized) {
          active.budgetExhaustedObserved = true;
          // Throw a BudgetExhaustedError rather than re-throwing the original error: the ORIGINAL
          // failure was auto-retryable and budget is the actual reason no further retry happens,
          // so the durable capsule's recoveryReason must say BUDGET_EXHAUSTED, not misattribute
          // the stop to whatever transient thing triggered this retry decision in the first place.
          throw new BudgetExhaustedError(
            `Recovery budget exhausted after a ${classification} failure (allocated ` +
              `$${budgetAuthorization.allocated?.toFixed(4)}, spent ` +
              `$${budgetAuthorization.spent.toFixed(4)}). Original error: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        active.recoveryAttemptsUsed += 1;
        await this.event(run.id, "RecoveryAttempted", {
          classification,
          attempt: active.recoveryAttemptsUsed,
          maxRecoveryAttempts: this.recoveryPolicy.maxRecoveryAttempts,
          error: error instanceof Error ? error.message : String(error),
          strategy: "NEW_BOUNDED_SESSION",
        });
        attemptResumeFrom = undefined;
        costCategory = "recovery";
      }
    }
  }

  private async runAgentAttempt(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
    credentialReferences: string[],
    message: string,
    resumeFrom?: AgentSession,
    costCategory: BudgetCategory = "execution",
  ): Promise<{ session: AgentSession; modelCostReported: boolean; restartRequested: boolean }> {
    const session =
      resumeFrom?.nativeSessionId !== undefined
        ? await this.dependencies.agent.resume(resumeFrom.nativeSessionId)
        : await this.dependencies.agent.start({
            run,
            task,
            workspacePath: sandbox.path,
            initialContext: contextState.current.text,
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
          const sanitizedCost = sanitizeReportedCost(agentEvent.data.costUsd);
          if (sanitizedCost !== null) {
            modelCostReported = true;
            // Recovery-retry attempts attribute their cost to the "recovery" reserve rather than
            // "execution" so that category's budget authorization reflects real spend instead of
            // always seeing zero. All other attempts (initial session, repair) are execution cost.
            if (costCategory === "recovery") run.cost.recovery += sanitizedCost;
            else run.cost.model += sanitizedCost;
            run.cost.total =
              run.cost.model +
              run.cost.sandbox +
              run.cost.verification +
              run.cost.retry +
              run.cost.recovery;
          } else if (agentEvent.data.costUsd !== undefined) {
            // Agent output is a proposal, never silently trusted — a negative, non-finite, or
            // implausibly large single-event cost is rejected rather than applied. This does not
            // (and cannot, without independent metering) stop an agent from under-reporting its
            // own cost to keep bypassing a HARD budget; it closes the two concrete abuse shapes a
            // self-reported number can otherwise cause: decrementing spend below zero, or forcing
            // an immediate self-inflicted pause by claiming an absurd cost.
            await this.event(run.id, "ImplausibleCostIgnored", {
              reported: agentEvent.data.costUsd,
            });
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
          const grown = await this.growGraph(
            run,
            task,
            sandbox,
            contextState,
            extractFileCandidates(agentEvent.data),
          );
          await this.observeAndDecide(run, {
            runId: run.id,
            type: "AGENT_EVENT",
            timestamp: agentEvent.timestamp,
            checkpoint:
              run.retryCount === 0
                ? `agent-${agentEvent.type}`
                : `verification-repair-${run.retryCount}-${agentEvent.type}`,
            event: agentEvent,
            ...(grown ? { repository: contextState.snapshot } : {}),
          });
        }
        if (agentEvent.type === "error") {
          // Agent-supplied text, never harness-authored — see AgentReportedFailure.
          throw new AgentReportedFailure(String(agentEvent.data.message ?? "Agent failed"));
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
    // ModeChanged is created by the controller (so it already has its identity/timestamp) rather
    // than through event(). It still crosses the same redaction boundary as every other event.
    await this.dependencies.store.appendEvent({
      ...event,
      data: redactSensitiveData(event.data),
    });
    const transitionState = this.active.get(run.id)?.transitionState;
    if (!transitionState) return;
    transitionState.count += 1;
    if (fromEffective === "STRICT") transitionState.strictReexpansions += 1;
    if (enforcement.method === "LIVE_UPDATE") transitionState.liveUpdates += 1;
    else if (enforcement.method === "SAFE_RESTART") transitionState.safeRestarts += 1;
    else transitionState.boundaryEnforcements += 1;
  }

  /** Rebuilds the session context when the effective mode changed since the last build. */
  private async refreshContext(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
  ): Promise<void> {
    if (contextState.mode === run.effectiveMode) return;
    // Selecting scope for the new mode needs only path/module data; scope-index any of the newly
    // selected files not already parsed so the re-rendered text carries real symbols, not a blank
    // "Relevant symbols" section for files the graph has not seen yet.
    const scope = await this.dependencies.contextBuilder.build({
      task,
      mode: run.effectiveMode,
      snapshot: contextState.snapshot,
      projectId: contextState.projectId,
    });
    await this.growGraphTrusted(run, task, sandbox, contextState, scope.initialFiles);
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
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
    attempt: number,
    parentCandidateId: string | undefined,
    fallbackAssessment: RiskAssessment,
  ): Promise<Candidate> {
    const diff = await this.dependencies.sandbox.collectDiff(sandbox);
    // The candidate retains exact paths for trusted analysis. The API-facing Run record needs
    // only display/count semantics, so filenames are sanitized before durable persistence.
    run.changedFiles = diff.changedFiles.map((file) => redactSensitiveText(file));
    run.updatedAt = new Date().toISOString();
    await this.dependencies.store.updateRun(run);
    const id = crypto.randomUUID();
    const baseRevision = await this.resolveRevision(sandbox.path);
    const artifact: Artifact = {
      id,
      runId: run.id,
      kind: "DIFF",
      uri: `sandbox://${run.id}/candidate-${attempt}.patch`,
      digest: LocalWorktreeSandbox.digest(diff),
      metadata: redactSensitiveData({
        candidateId: id,
        ...(baseRevision ? { baseRevision } : {}),
        attempt,
        parentCandidateId: parentCandidateId ?? null,
        changedFiles: diff.changedFiles,
        bytes: Buffer.byteLength(diff.patch),
        // Whole-line suppression for files with credential-shaped added lines — token-level
        // redaction leaves a private key's base64 body intact, and the preview is durable
        // harness evidence (see redactPatchPreview).
        preview: redactPatchPreview(diff.patch).slice(0, this.repairPolicy.maxDiffPreviewChars),
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
    const grown = await this.growGraphTrusted(run, task, sandbox, contextState, diff.changedFiles);
    await this.observeAndDecide(run, {
      runId: run.id,
      type: "DIFF_CAPTURED",
      timestamp: new Date().toISOString(),
      checkpoint: attempt === 1 ? "diff-captured" : `verification-repair-${attempt - 1}-diff`,
      diff,
      ...(grown ? { repository: contextState.snapshot } : {}),
    });
    // Ground truth refinement: the actual changed files, now that a diff exists. When the diff
    // touches nothing there is nothing to refine from -- the pre-execution estimate stands (the
    // quality gate still needs a vector to report against, and honest fallback beats absence).
    // The diff-captured vector also carries the M7A declared-debt marker counts from the patch
    // itself, so DebtRisk and the plan's DEBT decision reflect the diff, not a guess.
    const debtDelta = deriveDebtDelta(diff.patch);
    const assessment =
      diff.changedFiles.length > 0
        ? await this.assessRisk(
            run,
            task,
            contextState.snapshot,
            diff.changedFiles,
            "diff-captured",
            { added: debtDelta.addedMarkers, removed: debtDelta.removedMarkers },
            diff.patch,
          )
        : fallbackAssessment;
    return { id, artifact, diff, attempt, assessment };
  }

  /**
   * Computes a risk vector + assurance plan from the best currently-available estimate of touched
   * files and emits both as inspectable evidence, never a hidden internal value. Called from two
   * points: context-built scope (pre-execution estimate, before any diff exists) and the actual
   * diff's changed files (ground truth, refining the estimate) — see the M5 design note in the
   * program ledger. Deterministic given its inputs; never calls a model.
   */
  private async assessRisk(
    run: Run,
    task: Task,
    snapshot: RepositorySnapshot,
    files: string[],
    stage: "pre-execution" | "diff-captured",
    debtMarkers?: { added: number; removed: number },
    diffPatch?: string,
  ): Promise<RiskAssessment> {
    const riskVector = deriveRiskVector({
      files,
      moduleOwnership: snapshot.moduleOwnership,
      packageOwnership: snapshot.packageOwnership,
      crossModuleEdgeCount: countCrossModuleEdges(
        snapshot.relations,
        snapshot.moduleOwnership,
        files,
      ),
      ...(debtMarkers ? { debtMarkers } : {}),
      ...(diffPatch !== undefined ? { diffPatch } : {}),
    });
    const qualityPreference = task.qualityPreference ?? "BALANCED";
    const assurancePlan = buildAssurancePlan(riskVector, qualityPreference);
    await this.event(run.id, "RiskProfiled", { stage, files: files.length, riskVector });
    await this.event(run.id, "AssurancePlanned", {
      stage,
      qualityPreference,
      plan: assurancePlan,
    });
    return { riskVector, assurancePlan };
  }

  /**
   * M6 quality gate. Derives the candidate's quality report (a per-dimension vector, never a
   * scalar) from the trusted verification result plus the M5 risk/assurance evidence, runs an
   * independent review if — and only if — the assurance plan requires one, and derives the
   * candidate's trust state from exactly the evidence actually obtained. Deterministic evidence
   * stays authoritative: a model review can never override a failed verification (it is only
   * consulted after VERIFIED), and quality evidence is bound to this candidate's id + diff digest
   * so a review of one candidate can never promote another.
   */
  private async assessQuality(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
    candidate: Candidate,
    verification: Verification,
    initialModules: string[],
    preExecutionAssessment: RiskAssessment,
  ): Promise<QualityReport> {
    const assessment = candidate.assessment;
    if (this.active.get(run.id)?.cancelled) throw new Error("Run cancelled before assurance");
    const runtimeGraph = deriveRuntimeGraph(candidate.diff.patch);
    await this.event(run.id, "RuntimeGraphDerived", {
      candidateId: candidate.id,
      diffDigest: candidate.artifact.digest,
      graph: runtimeGraph,
    });
    const performancePosture = await this.measurePerformance(
      run,
      task,
      sandbox,
      candidate,
      verification,
    );
    if (this.active.get(run.id)?.cancelled)
      throw new Error("Run cancelled during performance assurance");
    const resiliencePosture = await this.verifyResilience(run, task, sandbox, candidate);
    if (this.active.get(run.id)?.cancelled)
      throw new Error("Run cancelled during resilience assurance");
    const report: QualityReport = deriveQualityReport({
      verificationState: verification.state,
      verificationCommand: task.verification.command ?? null,
      verificationExitCode: verification.exitCode,
      assurancePlan: assessment.assurancePlan,
      preExecutionRisk: preExecutionAssessment.riskVector,
      diffRisk: assessment.riskVector,
      changedFiles: candidate.diff.changedFiles,
      initialModules,
      moduleOwnership: contextState.snapshot.moduleOwnership,
      diffPatch: candidate.diff.patch,
      ...(performancePosture ? { performancePosture } : {}),
      ...(resiliencePosture ? { resiliencePosture } : {}),
    });
    // The report is derived before any reviewer session starts: if a gated dimension already caps
    // promotion at CORRECTNESS_VERIFIED, no verdict — approved or not — can change the outcome, so
    // the review spend would be dead weight. Skip it and record why.
    let review: { verdict: ReviewVerdict; reviewerSessionId: string } | undefined;
    let reviewSkipped: string | undefined;
    if (assessment.assurancePlan.required.includes("INDEPENDENT_REVIEW")) {
      if (
        deriveTrustState(verification.state, report, assessment.assurancePlan, true) ===
        "CORRECTNESS_VERIFIED"
      ) {
        reviewSkipped =
          "a gated quality dimension is not PASS, so no verdict can raise the trust state above CORRECTNESS_VERIFIED";
      } else {
        review = await this.runIndependentReview(run, task, sandbox, candidate, assessment);
      }
    }
    const trustState = deriveTrustState(
      verification.state,
      report,
      assessment.assurancePlan,
      review?.verdict.status === "APPROVED",
    );
    run.trustState = trustState;
    run.updatedAt = new Date().toISOString();
    await this.dependencies.store.updateRun(run);
    await this.event(run.id, "QualityAssessed", {
      candidateId: candidate.id,
      diffDigest: candidate.artifact.digest,
      report,
      trustState,
      ...(review
        ? {
            review: {
              status: review.verdict.status,
              reasons: review.verdict.reasons,
              reviewerSessionId: review.reviewerSessionId,
              candidateId: candidate.id,
              diffDigest: candidate.artifact.digest,
            },
          }
        : {}),
      ...(reviewSkipped ? { reviewSkipped } : {}),
    });
    return report;
  }

  /** M9 candidate-bound baseline/candidate measurement. Missing evidence remains NOT_CHECKED. */
  private async measurePerformance(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    candidate: Candidate,
    verification: Verification,
  ): Promise<PerformancePostureResult | undefined> {
    if (!candidate.assessment.assurancePlan.required.includes("PERFORMANCE")) return undefined;
    const candidateDigest = candidate.artifact.digest ?? "";
    let measurement: PerformanceMeasurement | undefined;
    if (verification.state !== "VERIFIED") {
      measurement = {
        state: "NOT_CHECKED",
        candidateId: candidate.id,
        diffDigest: candidateDigest,
        metrics: [],
        evidence: [
          "trusted correctness verification did not pass; performance command was skipped",
        ],
      };
    } else if (!task.performance) {
      measurement = {
        state: "NOT_CHECKED",
        candidateId: candidate.id,
        diffDigest: candidateDigest,
        metrics: [],
        evidence: ["no project performance measurement specification was configured"],
      };
    } else if (!this.dependencies.performanceVerifier) {
      measurement = {
        state: "NOT_CHECKED",
        candidateId: candidate.id,
        diffDigest: candidateDigest,
        metrics: [],
        evidence: ["no trusted performance verifier is available"],
      };
    } else {
      try {
        measurement = await this.dependencies.performanceVerifier.measure({
          run,
          task,
          sandbox,
          candidateId: candidate.id,
          diffDigest: candidateDigest,
        });
        if (this.active.get(run.id)?.cancelled)
          throw new Error("Run cancelled during performance measurement");
        const afterMeasurement = await this.dependencies.sandbox.collectDiff(sandbox);
        if (this.active.get(run.id)?.cancelled)
          throw new Error("Run cancelled during performance measurement");
        if (LocalWorktreeSandbox.digest(afterMeasurement) !== candidateDigest) {
          measurement = {
            state: "NOT_CHECKED",
            candidateId: candidate.id,
            diffDigest: candidateDigest,
            metrics: [],
            evidence: [
              "candidate workspace changed during performance measurement; evidence was invalidated",
            ],
          };
        }
      } catch (error) {
        if (this.active.get(run.id)?.cancelled) throw error;
        measurement = {
          state: "NOT_CHECKED",
          candidateId: candidate.id,
          diffDigest: candidateDigest,
          metrics: [],
          evidence: [
            `performance measurement failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
          ],
        };
      }
    }
    const posture = derivePerformancePosture(
      measurement,
      candidate.id,
      candidateDigest,
      task.performance?.maxRegressionPercent ?? 0,
    );
    await this.event(run.id, "PerformanceAssessed", {
      candidateId: candidate.id,
      diffDigest: candidateDigest,
      posture,
      measurementState: measurement?.state ?? "NOT_CHECKED",
    });
    return posture;
  }

  /**
   * M10 candidate-bound fault-injection verification. Scenario relevance is derived from the
   * candidate's own diff (plus the plan's CONCURRENCY decision), and only relevant scenarios are
   * executed — never a blanket scenario sweep. All evidence is bound to this candidate's id + diff
   * digest, and the workspace digest is re-collected afterwards so any mutation during scenario
   * execution invalidates the evidence. Local execution stays honestly labeled: this is resilience
   * evidence in a bounded local environment, never production verification.
   */
  private async verifyResilience(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    candidate: Candidate,
  ): Promise<ResiliencePostureResult | undefined> {
    const plan = candidate.assessment.assurancePlan;
    if (!plan.required.includes("RESILIENCE")) return undefined;
    const candidateDigest = candidate.artifact.digest ?? "";
    const relevance = deriveResilienceRelevance(
      candidate.diff.patch,
      plan.required.includes("CONCURRENCY"),
    );
    let measurement: ResilienceMeasurement | undefined;
    if (relevance.scenarios.length === 0) {
      // Zero relevant scenarios is deterministic diff evidence: there is nothing to inject, so no
      // verifier is consulted and no spec is demanded (see deriveResiliencePosture).
      measurement = undefined;
    } else if (!task.resilience) {
      measurement = {
        state: "NOT_CHECKED",
        candidateId: candidate.id,
        diffDigest: candidateDigest,
        scenarios: [],
        evidence: ["no resilience verification specification was configured"],
      };
    } else if (!this.dependencies.resilienceVerifier) {
      measurement = {
        state: "NOT_CHECKED",
        candidateId: candidate.id,
        diffDigest: candidateDigest,
        scenarios: [],
        evidence: ["no trusted resilience verifier is available"],
      };
    } else {
      try {
        const activeState = this.active.get(run.id);
        const verifyInput = {
          run,
          task,
          sandbox,
          candidateId: candidate.id,
          diffDigest: candidateDigest,
          relevance,
          ...(activeState ? { signal: activeState.verificationAbort.signal } : {}),
        };
        measurement = await this.dependencies.resilienceVerifier.verify(verifyInput);
        if (this.active.get(run.id)?.cancelled)
          throw new Error("Run cancelled during resilience verification");
        const afterVerification = await this.dependencies.sandbox.collectDiff(sandbox);
        if (this.active.get(run.id)?.cancelled)
          throw new Error("Run cancelled during resilience verification");
        if (LocalWorktreeSandbox.digest(afterVerification) !== candidateDigest) {
          measurement = {
            state: "NOT_CHECKED",
            candidateId: candidate.id,
            diffDigest: candidateDigest,
            scenarios: [],
            evidence: [
              "candidate workspace changed during resilience verification; evidence was invalidated",
            ],
          };
        } else if (
          task.resilience &&
          (task.resilience.composeFile || (task.resilience.evidenceInputs?.length ?? 0) > 0)
        ) {
          if (
            !measurement.executionInputDigest ||
            !this.dependencies.resilienceVerifier.captureEvidenceInputs
          ) {
            measurement = {
              state: "NOT_CHECKED",
              candidateId: candidate.id,
              diffDigest: candidateDigest,
              scenarios: [],
              evidence: [
                "resilience execution used declared external inputs, but the verifier did not provide a re-checkable input fingerprint",
              ],
            };
          } else {
            const afterInputs =
              await this.dependencies.resilienceVerifier.captureEvidenceInputs(verifyInput);
            if (afterInputs.digest !== measurement.executionInputDigest) {
              measurement = {
                state: "NOT_CHECKED",
                candidateId: candidate.id,
                diffDigest: candidateDigest,
                scenarios: [],
                evidence: [
                  "candidate resilience execution inputs changed during or after verification; evidence was invalidated",
                ],
              };
            }
          }
        }
      } catch (error) {
        if (this.active.get(run.id)?.cancelled) throw error;
        measurement = {
          state: "NOT_CHECKED",
          candidateId: candidate.id,
          diffDigest: candidateDigest,
          scenarios: [],
          evidence: [
            `resilience verification failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
          ],
        };
      }
    }
    const posture = deriveResiliencePosture(measurement, candidate.id, candidateDigest, relevance);
    await this.event(run.id, "ResilienceAssessed", {
      candidateId: candidate.id,
      diffDigest: candidateDigest,
      relevantScenarios: relevance.scenarios,
      posture,
      measurementState: measurement?.state ?? "NOT_CHECKED",
    });
    return posture;
  }

  /**
   * M6C independent review: a single fresh-context reviewer session (never a resume of the author's
   * session, never given the author's context or reasoning) whose verdict is parsed against a
   * bounded structured contract bound to the exact candidate under review. The reviewer's output is
   * evidence, not authority: a malformed/misdirected verdict is INVALID, and an INVALID or REJECTED
   * verdict simply withholds promotion. Exactly one attempt — no unbounded review loops. A failure
   * to run the reviewer at all is honestly reported (INVALID + reason) rather than swallowed.
   */
  private async runIndependentReview(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    candidate: Candidate,
    assessment: RiskAssessment,
  ): Promise<{ verdict: ReviewVerdict; reviewerSessionId: string }> {
    const verdictFileName = "independent-review-verdict.json";
    const maxChars = this.repairPolicy.maxDiffPreviewChars;
    const fullPatch = candidate.diff.patch;
    const reviewPatch = redactPatchPreview(fullPatch);
    const diffTruncated = reviewPatch.length > maxChars;
    const prompt = buildReviewPrompt({
      requirements: task.prompt,
      candidateId: candidate.id,
      diffDigest: candidate.artifact.digest ?? "",
      diffPatch: diffTruncated
        ? `${reviewPatch.slice(0, maxChars)}\n[TRUNCATED: the diff above was cut to ${maxChars} characters for this review, but the diffDigest you must echo covers the FULL diff. If the cut-off portion could affect your verdict, reject.]`
        : reviewPatch,
      riskVector: assessment.riskVector,
      assurancePlan: assessment.assurancePlan,
      verdictFileName,
    });
    await this.event(run.id, "IndependentReviewRequested", {
      candidateId: candidate.id,
      diffDigest: candidate.artifact.digest,
      reason: assessment.assurancePlan.reasons.INDEPENDENT_REVIEW,
      ...(diffTruncated ? { diffTruncated: true } : {}),
    });
    try {
      const { verdict, reviewerSessionId } = await this.runReviewerSession(
        run,
        task,
        sandbox,
        prompt,
        verdictFileName,
        candidate,
      );
      await this.event(run.id, "IndependentReviewCompleted", {
        candidateId: candidate.id,
        diffDigest: candidate.artifact.digest,
        status: verdict.status,
        reasons: verdict.reasons,
        reviewerSessionId,
        provenance: "MODEL_REVIEW",
      });
      return { verdict, reviewerSessionId };
    } catch (error) {
      // A cancellation is not a reviewer failure: rethrow so it propagates to the outer handler
      // and the run stays CANCELLED instead of being resurrected as COMPLETED below.
      if (this.active.get(run.id)?.cancelled) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const verdict: ReviewVerdict = {
        status: "INVALID",
        reasons: [`reviewer session failed: ${reason}`],
      };
      await this.event(run.id, "IndependentReviewCompleted", {
        candidateId: candidate.id,
        diffDigest: candidate.artifact.digest,
        status: verdict.status,
        reasons: verdict.reasons,
        provenance: "REVIEWER_SESSION_FAILED",
      });
      return { verdict, reviewerSessionId: "none" };
    }
  }

  /**
   * Runs the one bounded reviewer session and returns its parsed verdict. Deliberately simpler
   * than the execution path: no policy enforcement, no graph growth, no signal observation — the
   * reviewer only reads. Cost accounting still applies (its usage lands in run.usage, its reported
   * cost in run.cost.model), and like verification itself the review is never skipped for budget
   * reasons — mandatory trust must not be silently weakened by budget pressure (see M4C).
   */
  private async runReviewerSession(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    prompt: string,
    verdictFileName: string,
    candidate: Candidate,
  ): Promise<{ verdict: ReviewVerdict; reviewerSessionId: string }> {
    if (!this.circuitBreaker.canAttempt(run.provider)) {
      throw new ProviderCircuitOpenError(
        `Provider circuit is open for ${run.provider}: cannot run independent review`,
      );
    }
    if (this.circuitBreaker.state(run.provider) === "HALF_OPEN") {
      this.circuitBreaker.beginAttempt(run.provider);
    }
    try {
      const result = await this.consumeReviewerSession(
        run,
        task,
        sandbox,
        prompt,
        verdictFileName,
        candidate,
      );
      this.circuitBreaker.recordOutcome(run.provider, true);
      return result;
    } catch (error) {
      if (error instanceof ProviderCircuitOpenError) throw error;
      const classification = classifyFailure(error, {
        agentReported: error instanceof AgentReportedFailure,
      });
      if (providerRelatedClassifications.has(classification)) {
        this.circuitBreaker.recordOutcome(run.provider, false);
      } else {
        this.circuitBreaker.releaseProbe(run.provider);
      }
      throw error;
    }
  }

  private async consumeReviewerSession(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    prompt: string,
    verdictFileName: string,
    candidate: Candidate,
  ): Promise<{ verdict: ReviewVerdict; reviewerSessionId: string }> {
    const session = await this.dependencies.agent.start({
      run,
      // The reviewer sees the task's requirements but NOT the implementing agent's built context
      // or credential references — a fresh-context review, uncontaminated by the author's framing.
      task,
      workspacePath: sandbox.path,
      initialContext:
        "You are an independent reviewer session. Follow the instructions in the message exactly.",
      credentialReferences: [],
    });
    await this.dependencies.agent.send(session, prompt);
    let raw: string | undefined;
    try {
      for await (const agentEvent of this.dependencies.agent.events(session)) {
        if (this.active.get(run.id)?.cancelled) {
          await this.dependencies.agent.cancel(session);
          throw new Error("Run cancelled during independent review");
        }
        if (agentEvent.type === "usage") {
          run.usage.input += Number(agentEvent.data.inputTokens ?? 0);
          run.usage.output += Number(agentEvent.data.outputTokens ?? 0);
          run.usage.cached += Number(agentEvent.data.cachedTokens ?? 0);
          const sanitizedCost = sanitizeReportedCost(agentEvent.data.costUsd);
          if (sanitizedCost !== null) {
            run.cost.model += sanitizedCost;
            run.cost.total =
              run.cost.model +
              run.cost.sandbox +
              run.cost.verification +
              run.cost.retry +
              run.cost.recovery;
          }
        }
        if (agentEvent.type === "error") {
          throw new AgentReportedFailure(String(agentEvent.data.message ?? "Reviewer failed"));
        }
      }
      raw = await readFile(path.join(sandbox.path, verdictFileName), "utf8").catch(() => undefined);
      // Tamper check: the reviewer had write access to the sandbox, and "do not modify any other
      // file" was only prose. Remove the verdict file itself (its content is already read), then
      // re-collect the diff: if anything else moved, the digest no longer matches the candidate
      // under review and the verdict is INVALID — the reviewed/verified diff and the retained
      // workspace must not silently diverge.
      await rm(path.join(sandbox.path, verdictFileName), { force: true });
      const postReviewDiff = await this.dependencies.sandbox.collectDiff(sandbox);
      const postDigest = LocalWorktreeSandbox.digest(postReviewDiff);
      if (postDigest !== candidate.artifact.digest) {
        const verdict: ReviewVerdict = {
          status: "INVALID",
          reasons: [
            "workspace changed during independent review: the post-review diff digest does not match the candidate under review",
          ],
        };
        await this.event(run.id, "IndependentReviewCompleted", {
          candidateId: candidate.id,
          diffDigest: candidate.artifact.digest,
          status: verdict.status,
          reasons: verdict.reasons,
          reviewerSessionId: session.id ?? "unknown",
          provenance: "MODEL_REVIEW",
        });
        return { verdict, reviewerSessionId: session.id ?? "unknown" };
      }
    } finally {
      const current = this.active.get(run.id);
      if (current) {
        current.sessionActive = false;
        current.session = undefined;
      }
    }
    return {
      verdict: parseReviewVerdict(raw, {
        candidateId: candidate.id,
        diffDigest: candidate.artifact.digest ?? "",
      }),
      reviewerSessionId: session.id ?? "unknown",
    };
  }

  /**
   * Incrementally scope-indexes any candidate files not yet parsed and merges them onto the
   * shared graph the run is holding. Returns whether the graph actually grew, so callers only pay
   * the (small) cost of attaching the updated snapshot to an observation when something changed.
   */
  /**
   * Grows the graph from agent-claimed paths (tool calls, context-expansion declarations), which
   * need fuzzy resolution against the known-files list since the agent's own string data cannot
   * be trusted to be an exact repository-relative path.
   */
  private async growGraph(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
    candidates: string[],
  ): Promise<boolean> {
    const repositoryFiles = new Set(contextState.snapshot.files.map(normalizeFile));
    const resolved = [
      ...new Set(
        candidates
          .map((candidate) => findRepositoryFile(candidate, repositoryFiles))
          .filter((candidate): candidate is string => Boolean(candidate)),
      ),
    ];
    return this.applyGraphGrowth(run, task, sandbox, contextState, resolved);
  }

  /**
   * Grows the graph from already-exact repository-relative paths (git-status output, or module
   * ranking straight from the repository snapshot's own moduleMap) — no fuzzy resolution needed.
   * This is what lets a file the agent just created (and which therefore is not yet in the frozen
   * initial file list) reach indexScope's new-file registration.
   */
  private async growGraphTrusted(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
    trustedFiles: string[],
  ): Promise<boolean> {
    return this.applyGraphGrowth(run, task, sandbox, contextState, [
      ...new Set(trustedFiles.map(normalizeFile)),
    ]);
  }

  private async applyGraphGrowth(
    run: Run,
    task: Task,
    sandbox: Sandbox,
    contextState: ContextState,
    files: string[],
  ): Promise<boolean> {
    if (files.length === 0) return false;
    let updated: RepositorySnapshot;
    try {
      updated = await this.dependencies.repositoryIndex.indexScope(
        sandbox.path,
        task.revision,
        contextState.snapshot,
        files,
      );
    } catch (error) {
      // Scope-indexing enriches signal quality; it is not correctness-critical to completing the
      // run, so a transient read/parse failure must not fail the whole run over it.
      await this.event(run.id, "ScopeIndexFailed", {
        error: error instanceof Error ? error.message : String(error),
        requestedFiles: files.length,
      });
      return false;
    }
    if (updated === contextState.snapshot) return false;
    if (updated.scopeTruncated) {
      await this.event(run.id, "ScopeIndexTruncated", { requestedFiles: files.length });
    }
    contextState.snapshot = updated;
    return true;
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
      diffPreview: redactPatchPreview(candidate.diff.patch).slice(
        0,
        this.repairPolicy.maxDiffPreviewChars,
      ),
    });
    return [
      "Trusted verification repair request.",
      "The verifier is authoritative. Repair the candidate in the existing workspace and do not claim success without another verifier pass.",
      JSON.stringify(evidence, null, 2),
    ].join("\n\n");
  }

  /** Maps the existing CostBreakdown fields onto budget categories: nothing new to track. */
  private spentByCategory(run: Run): Record<BudgetCategory, number> {
    return {
      execution: run.cost.model + run.cost.sandbox,
      verification: run.cost.verification,
      recovery: run.cost.recovery + run.cost.retry,
    };
  }

  /**
   * Refuses to start a new agent session at all when even the execution reserve cannot fund it —
   * the M4C "do not execute" strategy. Throws BudgetExhaustedError, which execute()'s outer catch
   * turns into a durable capsule and PAUSED rather than ever starting an agent the budget cannot
   * support.
   */
  private requireExecutionBudget(
    run: Run,
    allocation: BudgetAllocation | null,
    mode: "ADVISORY" | "HARD",
    when: string,
  ): void {
    const authorization = authorizeSpend(allocation, this.spentByCategory(run), "execution", mode);
    if (!authorization.authorized) {
      throw new BudgetExhaustedError(
        `Execution budget exhausted ${when}: allocated $${authorization.allocated?.toFixed(4)}, ` +
          `spent $${authorization.spent.toFixed(4)}`,
      );
    }
  }

  /**
   * Builds and captures the durable, model-independent recovery evidence for a run that hit an
   * unhandled failure. Best-effort revision resolution (git rev-parse) never blocks or fails the
   * capsule itself — an unresolved revision is recorded as unknown, never guessed.
   */
  private async captureRecoveryCapsule(
    run: Run,
    task: Task,
    sandbox: Sandbox | undefined,
    classification: ReturnType<typeof classifyFailure>,
    detail: string,
  ): Promise<RecoveryCapsule> {
    const [artifacts, verifications, latestSignalSnapshot, knowledge] = await Promise.all([
      this.dependencies.store.listArtifacts(run.id),
      this.dependencies.store.listVerifications(run.id),
      this.dependencies.runtimeSignals.latest(run.id),
      this.dependencies.projectBrain.list(task.repositoryPath, task.revision, ["FACT", "DECISION"]),
    ]);
    const resolvedRevision = sandbox ? await this.resolveRevision(sandbox.path) : undefined;
    const allocation = computeAllocation(
      task.budget ?? { mode: "ADVISORY", limitUsd: null },
      this.budgetReservationPolicy,
    );
    const spent = this.spentByCategory(run);
    const remainingBudget =
      allocation === null
        ? null
        : allocation.total - (spent.execution + spent.verification + spent.recovery);
    return buildRecoveryCapsule({
      runId: run.id,
      task,
      agent: run.agent,
      model: run.model,
      provider: run.provider,
      desiredMode: run.desiredMode,
      effectiveMode: run.effectiveMode,
      costSpent: run.cost,
      workspacePath: sandbox?.path,
      resolvedRevision,
      artifacts,
      verifications,
      latestSignalSnapshot,
      knowledge,
      recoveryReason: classification,
      recoveryDetail: detail,
      remainingBudget,
    });
  }

  private async resolveRevision(cwd: string, ref = "HEAD"): Promise<string | undefined> {
    try {
      const result = await runProcess("git", ["rev-parse", ref], { cwd, timeoutMs: 5_000 });
      return result.exitCode === 0 ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
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
    // Collector state remains exact for live control decisions; its persisted/API copy is an
    // untrusted evidence record and crosses the same recursive redaction boundary as events.
    await this.dependencies.store.addSignalSnapshot(
      redactSensitiveData(snapshot) as RuntimeSignalSnapshot,
    );
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
    if (run.verificationState === "VERIFIED")
      return run.trustState === "MERGE_ELIGIBLE" ? "Verified handoff" : "Assurance blocked";
    if (run.verificationState === "QUARANTINED") return "Quarantine review";
    if (run.state === "QUEUED") return "Queued";
    if (lastEvent === "ContextBuilt") return "Agent execution";
    if (lastEvent === "DiffCaptured") return "Verification";
    return run.state === "RUNNING" ? "Repository and context" : run.state;
  }
}
