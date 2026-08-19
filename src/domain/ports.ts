import type {
  AgentCapabilities,
  AgentEvent,
  Artifact,
  Event,
  ExecutionMode,
  ModelHealth,
  Run,
  Task,
  TokenUsage,
  Verification,
} from "./types";

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

export interface RepositorySnapshot {
  revision: string;
  files: string[];
  symbols: Array<{ name: string; kind: string; file: string; line: number }>;
  relations: Array<{ from: string; to: string; kind: string }>;
  moduleMap: Record<string, string[]>;
  evidence: Array<{ uri: string; digest: string }>;
}

export interface RepositoryIndex {
  readonly name: string;
  index(repositoryPath: string, revision: string): Promise<RepositorySnapshot>;
  structuralSearch(repositoryPath: string, language: string, pattern: string): Promise<string[]>;
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
  build(
    request: ContextRequest,
  ): Promise<{ text: string; evidenceIds: string[]; tokenEstimate: number }>;
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
  cost: number;
  latencyMs: number;
  retryCount: number;
}

export interface ModelGateway {
  listModels(): Promise<string[]>;
  execute(request: ModelRequest): Promise<ModelResponse>;
  estimateCost(provider: string, model: string, usage: TokenUsage): Promise<number>;
  getProviderHealth(provider: string): Promise<ModelHealth>;
}

export interface TelemetryRecord {
  taskId: string;
  runId: string;
  agent: string;
  model: string;
  provider: string;
  executionMode: ExecutionMode;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelCost: number;
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
  verifiedSuccess: boolean;
  timestamp: string;
}

export interface TelemetrySink {
  record(record: TelemetryRecord): Promise<void>;
  costPerVerifiedSuccess(): Promise<number | null>;
}
