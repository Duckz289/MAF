import type { MissionContract } from "./mission";

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
  | "NOT_CHECKED"
  | "VERIFYING"
  | "VERIFIED"
  | "QUARANTINED"
  | "FAILED"
  | "CANCELLED";

/**
 * Evidence-backed trust ladder for a run's final candidate (M6A). Absent on legacy runs; PROPOSED
 * until deterministic verification succeeds. Never a display-only value: it is derived from the
 * quality report and (when required) an approved independent review, and gates merge eligibility.
 * DURABLE_VERIFIED (M10) additionally requires measured resilience evidence: the plan's relevant
 * fault scenarios were actually executed against this candidate and passed locally — a
 * heuristic "nothing relevant" verdict is not enough.
 */
export type TrustState =
  | "PROPOSED"
  | "CORRECTNESS_VERIFIED"
  | "QUALITY_VERIFIED"
  | "DURABLE_VERIFIED"
  | "MERGE_ELIGIBLE";

/**
 * PAUSED means a durable RecoveryCapsule was captured for this run's failure — the workspace and
 * all evidence are preserved and the run can be explicitly resumed. It carries strictly more
 * information than a bare FAILED and is used whenever recovery evidence was successfully built.
 */
export type RunState = "QUEUED" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
export type ModelHealth = "HEALTHY" | "DEGRADED" | "BROKEN";

export interface Task {
  id: string;
  prompt: string;
  /**
   * Canonical authority-bearing interpretation for current tasks. `prompt` remains compatibility
   * input and objective text; it is never itself an authority contract. Absent is legacy data,
   * never permission to infer authority from prose.
   */
  missionContract?: MissionContract;
  repositoryPath: string;
  revision: string;
  createdAt: string;
  verification: VerificationSpec;
  /** Optional trusted baseline/candidate command used only when the assurance plan requires it. */
  performance?: PerformanceSpec;
  /** Optional trusted fault-injection command used only when the assurance plan requires it. */
  resilience?: ResilienceSpec;
  signals?: RuntimeSignals;
  /** Absent means no budget was requested for this run — fully permissive, nothing to enforce. */
  budget?: { mode: "ADVISORY" | "HARD"; limitUsd: number };
  /** Absent defaults to BALANCED. Not "which model to use" — shapes assurance depth (see M5A). */
  qualityPreference?: "FAST" | "BALANCED" | "HIGH" | "CRITICAL";
}

export interface PerformanceSpec {
  command: string;
  metric: string;
  unit?: string | undefined;
  /** Candidate regression above this percentage fails the Performance quality dimension. */
  maxRegressionPercent: number;
  lowerIsBetter?: boolean | undefined;
  samples?: number | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Production-like failure scenarios the M10 resilience boundary can execute (M10). The candidate's
 * command runs once per relevant scenario with MAF_RESILIENCE_SCENARIO set to the scenario name,
 * so the project's own fault harness decides how each fault is injected.
 */
export type ResilienceScenario =
  | "HIGH_LATENCY"
  | "TIMEOUT"
  | "CONNECTION_RESET"
  | "DUPLICATE_REQUEST"
  | "OUT_OF_ORDER_RESPONSE"
  | "MALFORMED_UPSTREAM_RESPONSE"
  | "RATE_LIMITING";

/**
 * Optional trusted resilience fault-injection command used only when the assurance plan requires
 * RESILIENCE. `composeFile` optionally brings up a bounded ephemeral environment via
 * `docker compose up -d --wait` before the scenarios run (and tears it down afterwards) — Docker
 * Compose is the ceiling here; there is deliberately no Kubernetes path.
 */
export interface ResilienceSpec {
  command: string;
  /** Restrict execution to these scenarios; absent means every plan-relevant scenario runs. */
  scenarios?: ResilienceScenario[] | undefined;
  /**
   * Candidate-relative files outside Git's tracked diff that materially affect scenario
   * execution. Their contents are fingerprinted before and after verification; the Compose file
   * is included automatically.
   */
  evidenceInputs?: string[] | undefined;
  composeFile?: string | undefined;
  timeoutMs?: number | undefined;
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
  /** Derived (M6) from verification + quality report + any required independent review. */
  trustState?: TrustState;
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
  /** Canonical M12 scope, persisted before strategy evidence can be appended. */
  strategyEvidenceBinding?: {
    projectId: string;
    taskClass: string;
    riskProfile: string;
    qualityRequirement: "FAST" | "BALANCED" | "HIGH" | "CRITICAL";
    reviewPolicy: "NONE" | "REQUIRED";
  };
  /** Exact lifecycle-driving M12 values constructed by RunService and rebound by the store. */
  strategyObservationBinding?: StrategyObservationBinding;
  /** M13 immutable candidate-handoff identity; the store re-hashes the full payload. */
  deliveryHandoffBinding?: {
    handoffId: string;
    candidateId: string;
    candidateDigest: string;
    payloadDigest: string;
  };
}

export interface StrategyObservationBinding {
  id: string;
  timestamp: string;
  verifiedSuccess: boolean;
  costUsd: number | null;
  latencyMs: number;
  retries: number;
  qualityOutcome: "PASS" | "FAIL" | "UNKNOWN";
  security: "PASS" | "FAIL" | "NOT_CHECKED" | "NOT_REQUIRED";
  performance: "PASS" | "FAIL" | "NOT_CHECKED" | "NOT_REQUIRED";
  resilience: "PASS" | "FAIL" | "NOT_CHECKED" | "NOT_REQUIRED";
  healthEffect: "STABLE" | "DEGRADING" | "UNKNOWN";
  evidenceBasis: "RUN_STORE_VERIFIED" | "RUN_STORE_TERMINAL";
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
  /**
   * Structured execution evidence produced at the verifier boundary — the only place that knows
   * which shell ran and whether the verification command's NAME resolved inside it. Output-text
   * matching alone cannot reliably distinguish "the verifier command does not exist" (a broken
   * verification environment) from candidate-caused failures: on Windows PowerShell a missing
   * command exits 1 with prose no generic pattern matches. This field is consumed by failure
   * attribution ahead of any output regex.
   */
  execution?: VerifierExecutionEvidence;
}

export interface VerifierExecutionEvidence {
  /** False when the verifier's shell process itself could not be spawned. */
  shellSpawned: boolean;
  /**
   * RESOLVED: the shell started and reported no command-resolution error. COMMAND_NOT_FOUND: the
   * shell itself reported the verification command's name as unresolvable (the verifier toolchain
   * is unavailable — the candidate's code cannot cause this shape). SHELL_UNAVAILABLE: the shell
   * process could not be spawned at all. UNKNOWN: no structured evidence either way.
   */
  commandResolution: "RESOLVED" | "COMMAND_NOT_FOUND" | "SHELL_UNAVAILABLE" | "UNKNOWN";
  /**
   * How the verifier process ended, as observed by the boundary that ran it rather than inferred
   * from its output.
   *
   * COMPLETED   the process ran to completion and its exit code is meaningful.
   * TIMED_OUT   the harness's own timer stopped it. This is a HARNESS fact: no output pattern is
   *             needed, and none could be trusted — a candidate's program can print "timed out".
   * SIGNALLED   a signal terminated it (including the harness's escalation to a forced tree kill).
   * NOT_STARTED the shell never ran.
   *
   * A timeout is a bounded-execution outcome, not a test result. It is deliberately NOT reported
   * as a candidate failure (a candidate CAN hang, so repair stays available) and deliberately NOT
   * retried as an environment fault (re-running a timeout costs another full timeout and rarely
   * clears). Recording the shape structurally is what lets attribution choose correctly.
   */
  termination?: "COMPLETED" | "TIMED_OUT" | "SIGNALLED" | "NOT_STARTED";
  /** The signal that terminated the verifier process, when the runtime reported one. */
  terminatingSignal?: string;
  /** Wall-clock duration of the verification command, in milliseconds. */
  durationMs?: number;
  /** The timeout ceiling the verification command was run under, in milliseconds. */
  timeoutMs?: number;
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

/**
 * Why an unhandled execution failure occurred. Deterministic pattern-matched from the error and
 * known context; defaults honestly to UNKNOWN_FAILURE rather than guessing. VERIFICATION_FAILURE
 * is reserved for future gating use — the existing bounded repair loop already handles ordinary
 * verifier failures without reaching this classifier.
 */
export type FailureClassification =
  | "PROCESS_RESTART"
  | "PROVIDER_TRANSIENT"
  | "PROVIDER_DEGRADED"
  | "RATE_LIMIT"
  | "NETWORK_FAILURE"
  | "CREDENTIAL_FAILURE"
  | "AGENT_FAILURE"
  | "VERIFICATION_FAILURE"
  | "ENVIRONMENT_FAILURE"
  | "BUDGET_EXHAUSTED"
  | "USER_INTERRUPT"
  | "REVISION_CONFLICT"
  | "UNKNOWN_FAILURE";

export interface CandidateLineageEntry {
  id: string;
  attempt: number;
  parentCandidateId: string | null;
  artifactId: string;
  digest?: string | undefined;
  verification?: { id: string; state: VerificationState; attempt?: number } | undefined;
}

/**
 * A model-independent, structurally-typed snapshot of everything needed to recover or resume a
 * failed run. Never carries hidden chain-of-thought — only already-structured, already-persisted
 * evidence (verified facts/decisions, verification results, runtime-signal snapshot IDs, candidate
 * lineage) that existed before the capsule was built.
 */
export interface RecoveryCapsule {
  runId: string;
  taskId: string;
  goal: string;
  repositoryPath: string;
  /** The revision string the task requested (e.g. "HEAD" or a floating ref). */
  requestedRevision: string;
  /** The exact commit the sandbox actually resolved at capsule-creation time, if known. */
  resolvedRevision?: string | undefined;
  workspacePath?: string | undefined;
  agent: string;
  model: string;
  provider: string;
  desiredMode: ExecutionMode;
  effectiveMode: ExecutionMode;
  costSpent: CostBreakdown;
  /** UNKNOWN (null) until a budget authority exists (see the M4 roadmap milestone). */
  remainingBudget: number | null;
  candidateLineage: CandidateLineageEntry[];
  strongestCandidateId?: string | undefined;
  latestVerification?: { id: string; state: VerificationState; attempt?: number } | undefined;
  latestSignalSnapshotId?: string | undefined;
  /** Statements only — already evidence-backed FACT/DECISION records, never raw model reasoning. */
  verifiedFacts: string[];
  decisions: string[];
  recoveryReason: FailureClassification;
  recoveryDetail: string;
  /**
   * Safety limits ALREADY CONSUMED by this run before it paused. Restarting a paused run must not
   * hand it a fresh allowance: `maxRecoveryAttempts` and `maxPolicyRestarts` bound how much
   * automatic remediation a single run may spend, and a resume that reset them to zero would turn
   * every bounded limit into an unbounded one, one resume at a time. Absent on capsules written
   * before this field existed; a consumer reading a legacy capsule must say so rather than
   * assuming zero were used.
   */
  safetyCountersUsed?: {
    recoveryAttempts: number;
    policyRestarts: number;
  };
  createdAt: string;
}

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
