export type ExecutionMode = "STRICT" | "GUIDED" | "SOLO_NATIVE";

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
  executionMode: ExecutionMode;
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
  evidence: Record<string, number | string | boolean>;
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
  oauthAuth: boolean;
  apiKeyAuth: boolean;
  extensions: Record<string, boolean>;
}

export interface AgentEvent {
  type: "message" | "tool" | "usage" | "context_expansion" | "complete" | "error";
  data: Record<string, unknown>;
  timestamp: string;
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
