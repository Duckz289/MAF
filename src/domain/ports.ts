import type { HealthSample } from "./health";
import type { PerformanceMeasurement } from "./performance";
import type { CiEvidence, DeliveryHandoff } from "./delivery";
import type { ProductionFeedback } from "./production-feedback";
import type {
  ResilienceExecutionInputSnapshot,
  ResilienceMeasurement,
  ResilienceRelevanceEvidence,
} from "./resilience";
import type { StrategyObservation } from "./strategy";
import type { MonetaryCost, ModelPricingCatalog } from "./model-intelligence";
import type {
  ContextBudget,
  ContextBuildStage,
  ContextLedger,
  ContextSelection,
  ContextTokenMeasurement,
  ContextTokenMeter,
  TokenEstimateBasis,
} from "./context";
import type {
  ContextHandle,
  ContextPageRequest,
  ContextPageSourceResult,
  ContextWorkingSet,
} from "./context-navigation";
import type {
  AgentCapabilities,
  AgentEvent,
  AgentSecurityBoundary,
  Artifact,
  Event,
  ExecutionMode,
  ExecutionPolicyUpdate,
  ModelHealth,
  RecoveryCapsule,
  Run,
  RuntimeSignalSnapshot,
  RuntimeSignals,
  Task,
  TokenUsage,
  Verification,
} from "./types";

export type {
  CapabilityProbe,
  CapabilityFinding,
  CapabilityInput,
  CapabilityProvider,
  CapabilityResult,
  ProviderExecution,
  ProviderProvenance,
} from "./capability/provider";
export type {
  ActiveCapabilityBinding,
  BoundCapabilityResult,
  CapabilityBindingValidation,
} from "./capability/binding";

/**
 * Durable, process-independent harness control state. Emergency Stop is an explicit operator
 * decision to stop accepting work; holding it only in process memory meant a restart revoked it
 * without anyone deciding to. Stored as one named row so the flag survives the process that set it.
 */
export interface HarnessControlState {
  emergencyStopped: boolean;
  updatedAt: string;
  reason?: string | undefined;
}

export interface RunStore {
  createTask(task: Task): Promise<void>;
  getTask(id: string): Promise<Task | undefined>;
  createRun(run: Run): Promise<void>;
  updateRun(run: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(): Promise<Run[]>;
  appendEvent(event: Event<unknown>): Promise<void>;
  listEvents(runId: string, after?: string): Promise<Event<unknown>[]>;
  addArtifact(artifact: Artifact): Promise<void>;
  listArtifacts(runId: string): Promise<Artifact[]>;
  addVerification(verification: Verification): Promise<void>;
  listVerifications(runId: string): Promise<Verification[]>;
  addSignalSnapshot(snapshot: RuntimeSignalSnapshot): Promise<void>;
  listSignalSnapshots(runId: string): Promise<RuntimeSignalSnapshot[]>;
  /** Durable, model-independent recovery state. Overwrites any prior capsule for the same run. */
  saveRecoveryCapsule(capsule: RecoveryCapsule): Promise<void>;
  getRecoveryCapsule(runId: string): Promise<RecoveryCapsule | undefined>;
  /** M11 health ledger: append a sample; list returns samples oldest-first, bounded by the store. */
  saveHealthSample(sample: HealthSample): Promise<void>;
  listHealthSamples(projectId?: string, limit?: number): Promise<HealthSample[]>;
  /** M12: append only after binding the observation to verified run/candidate records. */
  saveStrategyObservation(observation: StrategyObservation): Promise<void>;
  listStrategyObservations(projectId?: string, limit?: number): Promise<StrategyObservation[]>;
  /** Atomic exact-scope/challenger sequence; the caller cannot choose/reuse canary slots. */
  allocateStrategyCanaryOrdinal(allocationKey: string): Promise<number>;
  /** M13 immutable, terminal-run-bound PR/CI evidence handoff. */
  saveDeliveryHandoff(handoff: DeliveryHandoff): Promise<void>;
  getDeliveryHandoff(runId: string): Promise<DeliveryHandoff | undefined>;
  saveCiEvidence(evidence: CiEvidence): Promise<void>;
  listCiEvidence(handoffId: string): Promise<CiEvidence[]>;
  saveProductionFeedback(feedback: ProductionFeedback): Promise<void>;
  listProductionFeedback(projectId?: string, limit?: number): Promise<ProductionFeedback[]>;
  /** Durable Emergency Stop state. Undefined means no operator decision has ever been recorded. */
  saveControlState(state: HarnessControlState): Promise<void>;
  getControlState(): Promise<HarnessControlState | undefined>;
}

/**
 * Trusted external CI boundary. Callers provide only an external run reference; this adapter must
 * obtain the conclusion from the CI system itself and bind it to the requested handoff.
 */
export interface CiEvidenceVerifierPort {
  collect(input: {
    handoff: DeliveryHandoff;
    provider: string;
    externalRunId: string;
  }): Promise<Omit<CiEvidence, "id" | "handoffId">>;
}

export interface ProductionFeedbackVerifierPort {
  collect(input: {
    provider: string;
    externalEventId: string;
  }): Promise<Omit<ProductionFeedback, "id">>;
}

export interface AgentStartInput {
  run: Run;
  task: Task;
  workspacePath: string;
  initialContext: string;
  credentialReferences: string[];
}

export interface AgentSession {
  id: string;
  nativeSessionId?: string;
}

export interface AgentAdapter {
  readonly name: string;
  capabilities(): Promise<AgentCapabilities>;
  start(input: AgentStartInput): Promise<AgentSession>;
  send(session: AgentSession, message: string): Promise<void>;
  events(session: AgentSession): AsyncIterable<AgentEvent>;
  cancel(session: AgentSession): Promise<void>;
  resume(nativeSessionId: string): Promise<AgentSession>;
  securityBoundary?(): Promise<AgentSecurityBoundary>;
  /**
   * Delivers a mid-session execution-policy update. Returns whether delivery succeeded; the mode
   * only becomes effective once the session emits a matching `policy` acknowledgement event.
   * Only meaningful for adapters that declare the `livePolicyUpdate` capability.
   */
  updatePolicy?(session: AgentSession, update: ExecutionPolicyUpdate): Promise<boolean>;
}

export interface Sandbox {
  id: string;
  path: string;
  repositoryPath: string;
  /** Immutable commit captured when the sandbox transaction was created. */
  baseRevision: string;
  /** Human/requested ref retained for reporting and source-drift checks. */
  revision: string;
}

export interface SandboxDiff {
  patch: string;
  changedFiles: string[];
  /** SHA-256 of the literal verification-workspace manifest, independent of Git presentation. */
  identityDigest?: string;
  /**
   * Content-free manifest captured in the same transaction as identityDigest. Infrastructure may
   * use it to prove that a fresh verification materialization contains the exact candidate bytes;
   * it carries digests and modes, never file contents or host paths.
   */
  candidateManifest?: Array<{ path: string; mode: "100644" | "100755" | "120000"; digest: string }>;
}

export interface SandboxProvider {
  create(runId: string, repositoryPath: string, revision: string): Promise<Sandbox>;
  collectDiff(sandbox: Sandbox): Promise<SandboxDiff>;
  cleanup(sandbox: Sandbox, verificationState: string): Promise<void>;
}

export interface VerifierPort {
  verify(run: Run, task: Task, sandbox: Sandbox, diff: SandboxDiff): Promise<Verification>;
  cancel(runId: string): Promise<void>;
}

export interface PerformanceMeasureInput {
  run: Run;
  task: Task;
  sandbox: Sandbox;
  candidateId: string;
  diffDigest: string;
}

/** Trusted local measurement boundary. Implementations compare the baseline and candidate. */
export interface PerformanceVerifierPort {
  measure(input: PerformanceMeasureInput): Promise<PerformanceMeasurement>;
}

export interface ResilienceVerifyInput {
  run: Run;
  task: Task;
  sandbox: Sandbox;
  candidateId: string;
  diffDigest: string;
  /** The plan-relevant scenarios derived from this candidate's own diff (M10). */
  relevance: ResilienceRelevanceEvidence;
  /**
   * Aborted when the run is cancelled: implementations must kill in-flight scenario subprocesses
   * promptly instead of letting them run to their timeouts. An aborted verify() may throw or
   * return partial evidence — the run is already cancelled and the caller rethrows.
   */
  signal?: AbortSignal;
}

/**
 * Trusted local fault-injection boundary (M10). Implementations execute each relevant
 * production-like failure scenario against the candidate workspace in a bounded ephemeral
 * environment. Local execution is resilience evidence — it is never production verification.
 */
export interface ResilienceVerifierPort {
  verify(input: ResilienceVerifyInput): Promise<ResilienceMeasurement>;
  /** Re-capture declared candidate-local execution inputs after verify() returns. */
  captureEvidenceInputs?(input: ResilienceVerifyInput): Promise<ResilienceExecutionInputSnapshot>;
}

export interface RepositorySnapshot {
  revision: string;
  /** All tracked files (paths only), up to the safety ceiling. Cheap at any repository size. */
  files: string[];
  /** True only if the tracked-file count exceeded the safety ceiling; never a silent truncation. */
  filesTruncated: boolean;
  /** Symbols/relations are populated only for files that have been through indexScope so far. */
  symbols: Array<{ name: string; kind: string; file: string; line: number }>;
  relations: Array<{ from: string; to: string; kind: string }>;
  /** File → deeper architectural module (e.g. `apps/web/src/domain`), derived from paths alone. */
  moduleMap: Record<string, string[]>;
  moduleOwnership: Record<string, string>;
  /** File → outer package/workspace root (e.g. `apps/web`), derived from paths alone. */
  packageOwnership: Record<string, string>;
  /** Package/workspace roots (not architectural modules); "module" in moduleOwnership is deeper. */
  moduleRoots: string[];
  /** Files indexScope has attempted (legacy cache semantics); successful parses are in evidence. */
  parsedFiles: string[];
  /** True only if the most recent indexScope call had to truncate its own requested file set. */
  scopeTruncated: boolean;
  /** Per-file content digest for every parsed file; the live cache for staleness detection. */
  evidence: Array<{ uri: string; digest: string }>;
}

export interface RepositoryIndex {
  readonly name: string;
  /** Cheap full pass: tracked files plus path-derived package/module ownership. No file content
   * is read, so this is safe to call on every task regardless of repository size. */
  index(repositoryPath: string, revision: string): Promise<RepositorySnapshot>;
  /**
   * Bounded parse of specific files into symbols and resolved local import relations, merged onto
   * the given snapshot. Each file's parse is cached by content digest, so calling this repeatedly
   * as scope grows during a run only does new work for files not already parsed at their current
   * digest. A changed digest invalidates the cached parse even when the URI remains present.
   */
  indexScope(
    repositoryPath: string,
    revision: string,
    snapshot: RepositorySnapshot,
    files: string[],
  ): Promise<RepositorySnapshot>;
  structuralSearch(repositoryPath: string, language: string, pattern: string): Promise<string[]>;
  status?(): RepositoryIndexStatus;
}

export interface RepositoryIndexStatus {
  engine: string;
  capability: "LOCAL_DETERMINISTIC" | "OPTIONAL_PORT" | "REAL_MCP";
  active: boolean;
  fallbackEngine?: string;
  detail: string;
}

export type KnowledgeStatus = "ACTIVE" | "STALE" | "CONFLICTED";
export type KnowledgeKind = "FACT" | "INFERENCE" | "EVIDENCE" | "DECISION";

export type KnowledgeStalenessInput =
  | { type: "SOURCE_DIGEST"; uri: string; digest: string }
  | { type: "MODULE_MEMBERSHIP"; module: string; digest: string };

export type KnowledgeScope =
  | { kind: "FILE"; identity: string }
  | { kind: "MODULE"; identity: string };

/** Minimal deterministic compiled-knowledge base; model compression is not eligible for this. */
export interface KnowledgeCompilation {
  schemaVersion: 1;
  kind: "MODULE_BOUNDARY";
  method: "DETERMINISTIC_REPOSITORY_INDEX";
  subject: string;
}

export interface KnowledgeProvenance {
  producer: "LOCAL_REPOSITORY_INDEX" | "VERIFIED_RUN" | "EXPLICIT_PROJECT_ASSERTION";
  source: "REPOSITORY_SNAPSHOT" | "VERIFICATION" | "USER_ASSERTION";
  sourceId: string;
  /** Digest of the exact source state. Never a model confidence score. */
  sourceDigest: string;
  runId?: string;
}

export interface KnowledgeRecord {
  id: string;
  projectId: string;
  revision: string;
  kind: KnowledgeKind;
  statement: string;
  evidenceIds: string[];
  status: KnowledgeStatus;
  createdAt: string;
  provenance: KnowledgeProvenance;
  /** Empty/missing means revision-global conservative invalidation. */
  stalenessInputs?: KnowledgeStalenessInput[];
  scope?: KnowledgeScope;
  compilation?: KnowledgeCompilation;
}

export type KnowledgeWriteResult = "INSERTED" | "REACTIVATED" | "UNCHANGED";

export interface KnowledgeBatchWriteResult {
  outcomes: Array<{ id: string; result: KnowledgeWriteResult }>;
  inserted: number;
  reactivated: number;
  unchanged: number;
}

export type KnowledgeResolutionState = "CURRENT" | "STALE" | "UNKNOWN" | "CONFLICTED";

export interface KnowledgeResolutionInput {
  projectId: string;
  revision: string;
  sourceDigests: Record<string, string>;
  moduleMembershipDigests: Record<string, string>;
  kinds?: KnowledgeKind[];
  ids?: string[];
  limit?: number;
}

export interface KnowledgeResolutionResult {
  current: KnowledgeRecord[];
  staleIds: string[];
  unknownIds: string[];
  conflictedIds: string[];
  examined: number;
  truncated: boolean;
}

export interface KnowledgeStalenessResult {
  examined: number;
  current: number;
  stale: number;
  unknown: number;
  conflicted: number;
  truncated: boolean;
}

export interface ProjectBrain {
  add(record: KnowledgeRecord): Promise<KnowledgeWriteResult>;
  /** Atomic publication boundary: every outcome commits, or no record in the batch is published. */
  addBatch(records: KnowledgeRecord[]): Promise<KnowledgeBatchWriteResult>;
  /** Every read is bounded. Callers may request a smaller page, never an unbounded collection. */
  list(
    projectId: string,
    revision: string,
    kinds?: KnowledgeKind[],
    limit?: number,
  ): Promise<KnowledgeRecord[]>;
  /** Revalidates source bindings at read time; handle/record existence never implies currency. */
  resolveCurrent(input: KnowledgeResolutionInput): Promise<KnowledgeResolutionResult>;
  /** Precise where source provenance is present; missing provenance stays conservative. */
  reconcileStaleness(
    input: Omit<KnowledgeResolutionInput, "kinds" | "ids" | "limit">,
  ): Promise<KnowledgeStalenessResult>;
  markStale(projectId: string, activeRevision: string): Promise<number>;
}

export interface ContextRequest {
  task: Task;
  mode: ExecutionMode;
  snapshot: RepositorySnapshot;
  projectId: string;
  runId?: string;
  stage?: ContextBuildStage;
  budget?: ContextBudget;
  /** Reuses the scope-only pager result after bounded parsing; avoids a second whole-map rank. */
  selection?: ContextSelection;
}

export interface ContextBuilderPort {
  selectInitialScope(request: ContextRequest): Promise<ContextSelection>;
  build(request: ContextRequest): Promise<ContextBuildResult>;
}

/** Cold-state resolver used by bounded navigation; the Working Set remains application-owned. */
export interface ContextPageSource {
  resolve(input: {
    repositoryPath: string;
    projectId: string;
    snapshot: RepositorySnapshot;
    handle: ContextHandle;
    request: ContextPageRequest;
    maxCharacters: number;
    maxItems: number;
    tokenMeter?: ContextTokenMeter;
  }): Promise<{ result: ContextPageSourceResult; snapshot: RepositorySnapshot }>;
}

export interface ContextBuildResult {
  text: string;
  evidenceIds: string[];
  tokenEstimate: number;
  tokenEstimateBasis: TokenEstimateBasis;
  tokenMeasurement: ContextTokenMeasurement;
  initialFiles: string[];
  initialModules: string[];
  handles: ContextHandle[];
  workingSet: ContextWorkingSet;
  evidenceReferencesTruncated: boolean;
  contextTruncated: boolean;
  knowledgeRead: {
    status: "AVAILABLE" | "UNAVAILABLE" | "NOT_REQUESTED";
    error?: string;
    stale?: number;
    unknown?: number;
    conflicted?: number;
  };
  ledger: ContextLedger;
}

export type RuntimeObservation =
  | {
      runId: string;
      type: "INITIAL_CONTEXT";
      timestamp: string;
      checkpoint: string;
      repository: RepositorySnapshot;
      initialFiles: string[];
      initialModules: string[];
      externalHints?: RuntimeSignals;
    }
  | {
      runId: string;
      type: "AGENT_EVENT";
      timestamp: string;
      checkpoint: string;
      event: AgentEvent;
      /** The latest incrementally-grown repository snapshot, if scope-indexing has run since the
       * last observation. Lets cross-module-edge detection see real resolved relations for
       * whatever has actually been touched, rather than a frozen initial snapshot. */
      repository?: RepositorySnapshot;
    }
  | {
      runId: string;
      type: "DIFF_CAPTURED";
      timestamp: string;
      checkpoint: string;
      diff: SandboxDiff;
      repository?: RepositorySnapshot;
    }
  | {
      runId: string;
      type: "VERIFICATION";
      timestamp: string;
      checkpoint: string;
      verification: Verification;
    };

export interface RuntimeSignalCollector {
  observe(observation: RuntimeObservation): Promise<RuntimeSignalSnapshot>;
  latest(runId: string): Promise<RuntimeSignalSnapshot | undefined>;
  history(runId: string): Promise<RuntimeSignalSnapshot[]>;
}

export type AuthStrategy =
  | "NATIVE_OAUTH"
  | "MANAGED_OAUTH"
  | "USER_API_KEY"
  | "PLATFORM_MANAGED_KEY"
  | "GATEWAY_MANAGED";

export interface CredentialBinding {
  id: string;
  ownerId: string;
  provider: string;
  strategy: AuthStrategy;
  credentialReference: string;
  scope: string[];
  status: "ACTIVE" | "REVOKED" | "ERROR";
  metadata: Record<string, string>;
}

export interface CredentialResolver {
  resolve(reference: string, provider: string): Promise<string>;
}

export interface UserSession {
  userId: string;
  email: string;
  organizationId?: string;
  verification: "MOCK_VERIFIED" | "REAL_PROVIDER_VERIFIED";
}

export interface UserAuthProvider {
  session(headers: Record<string, string | string[] | undefined>): Promise<UserSession | undefined>;
}

export interface ExternalConnectionProvider {
  createAuthorizationUrl(provider: string, ownerId: string): Promise<string>;
  getConnectionReference(provider: string, ownerId: string): Promise<string | undefined>;
}

export interface PlatformApiKeyProvider {
  issue(ownerId: string, scopes: string[]): Promise<{ key: string; id: string }>;
  verify(key: string, scope: string): Promise<boolean>;
  revoke(id: string): Promise<void>;
  list(ownerId: string): Promise<PlatformApiKeyMetadata[]>;
}

export interface PlatformApiKeyMetadata {
  id: string;
  ownerId: string;
  scopes: string[];
  revoked: boolean;
  createdAt: string;
}

export interface ModelRequest {
  provider: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  credentialReference?: string;
  metadata: Record<string, string>;
}

export interface ModelResponse {
  content: string;
  usage: TokenUsage;
  cost: MonetaryCost;
  latencyMs: number;
  retryCount: number;
}

export interface ModelGateway {
  listModels(): Promise<string[]>;
  execute(request: ModelRequest): Promise<ModelResponse>;
  estimateCost(provider: string, model: string, usage: TokenUsage): Promise<MonetaryCost>;
  getProviderHealth(provider: string): Promise<ModelHealth>;
}

export type { ModelPricingCatalog };

export interface TelemetryRecord {
  taskId: string;
  runId: string;
  /** Opaque project scope for longitudinal evidence; legacy records may omit it. */
  projectId?: string;
  agent: string;
  model: string;
  provider: string;
  initialMode: ExecutionMode;
  finalMode: ExecutionMode;
  finalDesiredMode: ExecutionMode;
  executionMode: ExecutionMode;
  policyLiveUpdates: number;
  policyBoundaryEnforcements: number;
  policySafeRestarts: number;
  pendingPolicyAtCompletion: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /**
   * Model spend. When non-null this is the agent client's own cost estimate (e.g. Claude CLI's
   * `total_cost_usd`) — an ESTIMATE computed client-side from token usage, not observed billed
   * spend. Evaluation/benchmark layers must label it as an estimate (costBasis/costStatus =
   * UNKNOWN), never present it as actual billed cost. Null means no estimate was reported at all.
   */
  modelCost: number | null;
  sandboxCost: number;
  verificationCost: number;
  retryCost: number;
  recoveryCost: number;
  latencyMs: number;
  retryCount: number;
  /** Optional M11 operational-health metrics — absent means not recorded, not zero. */
  toolCalls?: number;
  contextChars?: number;
  filesChanged: number;
  verificationType: string;
  verificationState: string;
  verificationSpecIdentity?: string;
  verificationEnvironmentIdentity?: string;
  modeTransitions: number;
  strictReexpansions: number;
  signalSnapshots: number;
  latestSignalSnapshotId?: string;
  dependencyExpansion: number;
  touchedModules: number;
  crossModuleEdges: number;
  verifierFailures: number;
  verificationAttempts: number;
  repairAttempts: number;
  moduleCountObserved: number;
  stabilizationInvalidations: number;
  contextExpansion: number;
  verifiedSuccess: boolean;
  budgetMode: "ADVISORY" | "HARD";
  /** null when no budget was configured for this run — unknown, not zero. */
  budgetLimitUsd: number | null;
  budgetExhausted: boolean;
  timestamp: string;
}

export interface TelemetrySink {
  record(record: TelemetryRecord): Promise<void>;
  /**
   * Arithmetic mean of the total cost of telemetry records marked verifiedSuccess.
   *
   * This is a product-usage statistic, not the evaluation protocol's cost per Durable Verified
   * Success. That quantity is total cost of all runs in scope divided by the number of successes and
   * lives in src/evaluation/metrics.ts; the two answer different questions and will differ.
   */
  costPerVerifiedSuccess(): Promise<number | null>;
  /**
   * M11 health-ledger source for the operational trend window. Optional: a sink that cannot list
   * its records leaves the operational group absent — unknown, not zero — and the ledger stays
   * structural/change-only rather than inventing numbers.
   */
  listRecords?(limit?: number, projectId?: string): Promise<TelemetryRecord[]>;
}
