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
  Task,
  TokenUsage,
  Verification,
  RuntimeSignalSnapshot,
  RuntimeSignals,
} from "./types";
import type { PerformanceMeasurement } from "./performance";

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
  revision: string;
}

export interface SandboxDiff {
  patch: string;
  changedFiles: string[];
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
  /** Files that have actually been parsed for symbols/relations via indexScope. */
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
   * content. Files already in `snapshot.parsedFiles` are skipped.
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

export type KnowledgeStatus = "ACTIVE" | "STALE";
export type KnowledgeKind = "FACT" | "INFERENCE" | "EVIDENCE" | "DECISION";

export interface KnowledgeRecord {
  id: string;
  projectId: string;
  revision: string;
  kind: KnowledgeKind;
  statement: string;
  evidenceIds: string[];
  status: KnowledgeStatus;
  createdAt: string;
}

export interface ProjectBrain {
  add(record: KnowledgeRecord): Promise<void>;
  list(projectId: string, revision: string, kinds?: KnowledgeKind[]): Promise<KnowledgeRecord[]>;
  markStale(projectId: string, activeRevision: string): Promise<number>;
}

export interface ContextRequest {
  task: Task;
  mode: ExecutionMode;
  snapshot: RepositorySnapshot;
  projectId: string;
}

export interface ContextBuilderPort {
  build(request: ContextRequest): Promise<ContextBuildResult>;
}

export interface ContextBuildResult {
  text: string;
  evidenceIds: string[];
  tokenEstimate: number;
  initialFiles: string[];
  initialModules: string[];
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
  cost: number | null;
  latencyMs: number;
  retryCount: number;
}

export interface ModelGateway {
  listModels(): Promise<string[]>;
  execute(request: ModelRequest): Promise<ModelResponse>;
  estimateCost(provider: string, model: string, usage: TokenUsage): Promise<number | null>;
  getProviderHealth(provider: string): Promise<ModelHealth>;
}

export interface TelemetryRecord {
  taskId: string;
  runId: string;
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
  modelCost: number | null;
  sandboxCost: number;
  verificationCost: number;
  retryCost: number;
  recoveryCost: number;
  latencyMs: number;
  retryCount: number;
  filesChanged: number;
  verificationType: string;
  verificationState: string;
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
  costPerVerifiedSuccess(): Promise<number | null>;
}
