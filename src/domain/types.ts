export type ExecutionMode = "STRICT" | "GUIDED" | "SOLO_NATIVE";

/** Ascending execution freedom. Used to classify transitions as tightening or broadening. */
const executionFreedomOrder: Record<ExecutionMode, number> = {
  STRICT: 0,
  GUIDED: 1,
  SOLO_NATIVE: 2,
};

export type ModeTransitionDirection = "TIGHTENING" | "BROADENING";

export const modeTransitionDirection = (
  from: ExecutionMode,
  to: ExecutionMode,
): ModeTransitionDirection =>
  executionFreedomOrder[to] < executionFreedomOrder[from] ? "TIGHTENING" : "BROADENING";

/**
 * How a desired execution-mode change was actually enforced on execution.
 * - LIVE_UPDATE: the running session acknowledged a policy update.
 * - SAFE_RESTART: the session was restarted from the existing workspace under the new policy.
 * - DEFERRED_BOUNDARY: applied at the next safe execution boundary after a session ended.
 * - SESSION_BOUNDARY: no session was active; the next session starts under the new policy.
 */
export type ModeEnforcementMethod =
  | "LIVE_UPDATE"
  | "SAFE_RESTART"
  | "DEFERRED_BOUNDARY"
  | "SESSION_BOUNDARY";

export type VerificationState =
  | "PROPOSED"
  | "VERIFYING"
  | "VERIFIED"
  | "QUARANTINED"
  | "FAILED"
  | "CANCELLED";

export type RunState = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type ModelHealth = "HEALTHY" | "DEGRADED" | "BROKEN";

export interface Task {
  id: string;
  prompt: string;
  repositoryPath: string;
  revision: string;
  createdAt: string;
  verification: VerificationSpec;
  signals?: RuntimeSignals;
}

export interface VerificationSpec {
  command?: string | undefined;
  expectedFile?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface Run {
  id: string;
  taskId: string;
  state: RunState;
  /** Compatibility mirror of {@link Run.effectiveMode}. Never reflects unenforced desired state. */
  executionMode: ExecutionMode;
  /** The mode the adaptive policy wants. May differ from effectiveMode until enforced. */
  desiredMode: ExecutionMode;
  /** The mode actually enforced on the current/next agent session, backed by evidence. */
  effectiveMode: ExecutionMode;
  verificationState: VerificationState;
  agent: string;
  model: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  sandboxPath?: string;
  changedFiles: string[];
  error?: string;
  cost: CostBreakdown;
  usage: TokenUsage;
  retryCount: number;
}

export interface Event<T = unknown> {
  id: string;
  runId: string;
  type: string;
  timestamp: string;
  data: T;
}

export interface ModeChangedData {
  from: ExecutionMode;
  to: ExecutionMode;
  reason: string;
  evidence: Record<string, unknown>;
  signalSnapshotId?: string;
  evidenceIds?: string[];
  /** Present on enforcement events; absent only on legacy records. */
  enforcement?: {
    method: ModeEnforcementMethod;
    evidence: Record<string, unknown>;
  };
}

export interface ModeChangeRequestedData {
  fromDesired: ExecutionMode;
  toDesired: ExecutionMode;
  effectiveMode: ExecutionMode;
  reason: string;
  evidence: Record<string, unknown>;
  plannedEnforcement: ModeEnforcementMethod;
  signalSnapshotId?: string;
  evidenceIds?: string[];
}

export interface Artifact {
  id: string;
  runId: string;
  kind: "DIFF" | "LOG" | "FILE" | "CONTEXT";
  uri: string;
  digest?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Verification {
  id: string;
  runId: string;
  type: string;
  state: VerificationState;
  command?: string;
  exitCode?: number;
  output: string;
  startedAt: string;
  completedAt: string;
  attempt?: number;
  candidateId?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
}

export interface CostBreakdown {
  model: number;
  sandbox: number;
  verification: number;
  retry: number;
  recovery: number;
  total: number;
}

export interface RuntimeSignals {
  dependencyExpansion?: number | undefined;
  touchedModules?: number | undefined;
  rootCauseUncertainty?: number | undefined;
  repeatedVerifierFailures?: number | undefined;
  contextExpansion?: number | undefined;
  crossModuleEdges?: number | undefined;
  scopeStabilized?: boolean | undefined;
  mechanicalRemainingWork?: boolean | undefined;
  independentWorkstreams?: number | undefined;
  filesChanged?: number | undefined;
  newDependenciesDiscovered?: number | undefined;
  verificationFailureCount?: number | undefined;
  stabilizationInvalidations?: number | undefined;
}

export type RuntimeSignalName = keyof RuntimeSignals;
export type RuntimeSignalProvenance =
  | "DETERMINISTIC"
  | "HEURISTIC"
  | "AGENT_INFERENCE"
  | "EXTERNAL_HINT";
export type RuntimeSignalReliability = "HIGH" | "MEDIUM" | "LOW";

export interface RuntimeSignalEvidence {
  id: string;
  source: string;
  provenance: RuntimeSignalProvenance;
  summary: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface RuntimeSignalValue<T extends number | boolean = number | boolean> {
  value: T;
  source: string;
  provenance: RuntimeSignalProvenance;
  reliability: RuntimeSignalReliability;
  evidenceIds: string[];
  timestamp: string;
}

export type RuntimeSignalValues = Partial<{
  [Name in RuntimeSignalName]: RuntimeSignalValue<NonNullable<RuntimeSignals[Name]>>;
}>;

export interface RuntimeSignalSnapshot {
  id: string;
  runId: string;
  sequence: number;
  checkpoint: string;
  timestamp: string;
  signals: RuntimeSignalValues;
  evidence: RuntimeSignalEvidence[];
}

export const signalValues = (snapshot: RuntimeSignalSnapshot): RuntimeSignals =>
  Object.fromEntries(
    Object.entries(snapshot.signals).map(([name, signal]) => [name, signal?.value]),
  ) as RuntimeSignals;

export type CredentialBoundaryCapability =
  | "REFERENCE_ONLY"
  | "REDACTED"
  | "PROXY_MEDIATED"
  | "ISOLATED";

export interface AgentSecurityBoundary {
  credentialCapability: CredentialBoundaryCapability;
  environmentAllowlist: boolean;
  processIsolation: boolean;
  networkIsolation: boolean;
  notes: string[];
}

export interface AgentCapabilities {
  repoSearch: boolean;
  fileRead: boolean;
  fileWrite: boolean;
  shell: boolean;
  browser: boolean;
  mcp: boolean;
  nativePlanning: boolean;
  nativeSubagents: boolean;
  contextManagement: boolean;
  streaming: boolean;
  resumeSession: boolean;
  /** The running session accepts mid-session execution-policy updates and acknowledges them. */
  livePolicyUpdate: boolean;
  /** The agent can be safely restarted from the existing workspace under a new policy. */
  safeSessionRestart: boolean;
  oauthAuth: boolean;
  apiKeyAuth: boolean;
  extensions: Record<string, boolean>;
}

export interface AgentEvent {
  type: "message" | "tool" | "usage" | "context_expansion" | "policy" | "complete" | "error";
  data: Record<string, unknown>;
  timestamp: string;
}

/** Payload delivered to a live session when the harness changes the execution policy. */
export interface ExecutionPolicyUpdate {
  mode: ExecutionMode;
  reason: string;
  requestId: string;
}

export const emptyCost = (): CostBreakdown => ({
  model: 0,
  sandbox: 0,
  verification: 0,
  retry: 0,
  recovery: 0,
  total: 0,
});

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cached: 0 });
