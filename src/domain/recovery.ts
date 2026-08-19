import type { KnowledgeRecord } from "./ports";
import type {
  Artifact,
  CandidateLineageEntry,
  CostBreakdown,
  ExecutionMode,
  FailureClassification,
  RecoveryCapsule,
  RuntimeSignalSnapshot,
  Task,
  Verification,
  VerificationState,
} from "./types";

/**
 * Marks an error whose message text originated from agent-supplied data (an `error` AgentEvent's
 * `message` field) rather than the harness's own internal logic. Agent output is a proposal, never
 * silently trusted — see classifyFailure's `agentReported` context flag for why this matters.
 */
export class AgentReportedFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentReportedFailure";
  }
}

/**
 * Deterministic failure classifier. Context hints the caller already knows for certain (e.g. an
 * explicit user cancellation) take priority over message pattern-matching; anything unrecognized
 * defaults honestly to UNKNOWN_FAILURE rather than guessing a more specific — and possibly
 * wrong — category.
 */
export interface FailureContext {
  cancelled?: boolean;
  /**
   * True when the error text came from the agent itself, not the harness. An agent could put any
   * string it likes into its own error message — claiming "rate limited" or "network failure" to
   * get auto-retried, or even the harness's own cancellation sentinel text to get misclassified as
   * USER_INTERRUPT. Pattern-matching agent-supplied text into a more specific, seemingly
   * system-verified category would let agent output silently masquerade as harness-determined
   * ground truth in the durable RecoveryCapsule. An agent-reported failure is therefore always
   * classified as AGENT_FAILURE — already auto-retryable and bounded, so no capability is lost,
   * but the classification stays honest about what the harness actually knows versus what the
   * agent merely claimed.
   */
  agentReported?: boolean;
  /** True when a HARD budget category was exhausted — a harness-determined, definitive fact. */
  budgetExhausted?: boolean;
  /** True when a provider's circuit breaker refused the attempt before it was even made. */
  circuitOpen?: boolean;
}

const patternClassification: Array<[RegExp, FailureClassification]> = [
  [/rate.?limit|too many requests|\b429\b/iu, "RATE_LIMIT"],
  [
    /credential|unauthorized|forbidden|invalid api key|authentication|\b401\b|\b403\b/iu,
    "CREDENTIAL_FAILURE",
  ],
  [/bad gateway|service unavailable|gateway timeout|\b50[0234]\b|\b529\b/iu, "PROVIDER_DEGRADED"],
  [
    /econnreset|econnrefused|etimedout|eai_again|enotfound|network|fetch failed|socket hang up/iu,
    "NETWORK_FAILURE",
  ],
  [/enospc|eacces|eperm|worktree|sandbox|disk|permission denied/iu, "ENVIRONMENT_FAILURE"],
  [/run cancelled/iu, "USER_INTERRUPT"],
  [/agent failed|agent (?:process|session) (?:exited|closed|crashed)/iu, "AGENT_FAILURE"],
  [/timeout|timed out|econnaborted/iu, "PROVIDER_TRANSIENT"],
];

export const classifyFailure = (
  error: unknown,
  context: FailureContext = {},
): FailureClassification => {
  if (context.cancelled) return "USER_INTERRUPT";
  if (context.budgetExhausted) return "BUDGET_EXHAUSTED";
  if (context.circuitOpen) return "PROVIDER_DEGRADED";
  if (context.agentReported) return "AGENT_FAILURE";
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, classification] of patternClassification) {
    if (pattern.test(message)) return classification;
  }
  return "UNKNOWN_FAILURE";
};

/**
 * Whether a run should attempt a bounded automatic recovery for this failure class, versus
 * requiring explicit resume/escalation. Conservative by default: only failure classes where a
 * retry has a real chance of succeeding without new input are auto-retryable. Everything else
 * (credentials, environment, budget, user action, revision conflicts, and anything unrecognized)
 * requires a human or an explicit policy decision — retrying blindly would not fix the cause and
 * would just spend budget while making no progress.
 */
export const isAutoRetryable = (classification: FailureClassification): boolean =>
  (
    [
      "PROVIDER_TRANSIENT",
      "PROVIDER_DEGRADED",
      "RATE_LIMIT",
      "NETWORK_FAILURE",
      "AGENT_FAILURE",
    ] as const
  ).includes(classification as never);

export const verificationSeverity = (verification: Pick<Verification, "state">): number => {
  if (verification.state === "VERIFIED") return 0;
  if (verification.state === "QUARANTINED") return 1;
  if (verification.state === "FAILED") return 2;
  return 3;
};

/**
 * Reconstructs candidate lineage from already-persisted artifacts and verifications. Pure and
 * read-only: nothing is ever deleted, so lineage is always fully reconstructable from history.
 */
export const candidateLineage = (
  artifacts: Artifact[],
  verifications: Verification[],
): CandidateLineageEntry[] => {
  const verificationByCandidateId = new Map(
    verifications
      .filter((verification) => verification.candidateId)
      .map((verification) => [verification.candidateId as string, verification]),
  );
  return artifacts
    .filter(
      (artifact) => artifact.kind === "DIFF" && typeof artifact.metadata.candidateId === "string",
    )
    .map((artifact) => {
      const candidateId = artifact.metadata.candidateId as string;
      const verification = verificationByCandidateId.get(candidateId);
      return {
        id: candidateId,
        attempt: typeof artifact.metadata.attempt === "number" ? artifact.metadata.attempt : 0,
        parentCandidateId:
          typeof artifact.metadata.parentCandidateId === "string"
            ? artifact.metadata.parentCandidateId
            : null,
        artifactId: artifact.id,
        digest: artifact.digest,
        ...(verification
          ? {
              verification: {
                id: verification.id,
                state: verification.state,
                ...(verification.attempt !== undefined ? { attempt: verification.attempt } : {}),
              },
            }
          : {}),
      };
    })
    .sort((left, right) => left.attempt - right.attempt);
};

/**
 * The best-verified candidate in the lineage, so a failed later repair can never silently cause
 * an earlier better-verified candidate to be forgotten. Ties prefer the later attempt (more
 * evidence gathered since). Returns undefined if nothing in the lineage has been verified yet.
 */
export const strongestCandidate = (
  lineage: CandidateLineageEntry[],
): CandidateLineageEntry | undefined => {
  const verified = lineage.filter(
    (
      candidate,
    ): candidate is CandidateLineageEntry & {
      verification: NonNullable<CandidateLineageEntry["verification"]>;
    } => candidate.verification !== undefined,
  );
  if (verified.length === 0) return undefined;
  return [...verified].sort((left, right) => {
    const severityDelta =
      verificationSeverity({ state: left.verification.state }) -
      verificationSeverity({ state: right.verification.state });
    if (severityDelta !== 0) return severityDelta;
    return right.attempt - left.attempt;
  })[0];
};

export interface RecoveryCapsuleInput {
  runId: string;
  task: Task;
  agent: string;
  model: string;
  provider: string;
  desiredMode: ExecutionMode;
  effectiveMode: ExecutionMode;
  costSpent: CostBreakdown;
  workspacePath?: string | undefined;
  resolvedRevision?: string | undefined;
  artifacts: Artifact[];
  verifications: Verification[];
  latestSignalSnapshot?: RuntimeSignalSnapshot | undefined;
  knowledge: KnowledgeRecord[];
  recoveryReason: FailureClassification;
  recoveryDetail: string;
  /** Caller-computed (budget.ts owns the arithmetic); null when no budget was configured. */
  remainingBudget?: number | null | undefined;
  now?: string;
}

const summarizeVerification = (
  verification: Verification | undefined,
): { id: string; state: VerificationState; attempt?: number } | undefined =>
  verification
    ? {
        id: verification.id,
        state: verification.state,
        ...(verification.attempt !== undefined ? { attempt: verification.attempt } : {}),
      }
    : undefined;

export const buildRecoveryCapsule = (input: RecoveryCapsuleInput): RecoveryCapsule => {
  const lineage = candidateLineage(input.artifacts, input.verifications);
  const strongest = strongestCandidate(lineage);
  const latestVerification = input.verifications.at(-1);
  return {
    runId: input.runId,
    taskId: input.task.id,
    goal: input.task.prompt,
    repositoryPath: input.task.repositoryPath,
    requestedRevision: input.task.revision,
    resolvedRevision: input.resolvedRevision,
    workspacePath: input.workspacePath,
    agent: input.agent,
    model: input.model,
    provider: input.provider,
    desiredMode: input.desiredMode,
    effectiveMode: input.effectiveMode,
    costSpent: input.costSpent,
    remainingBudget: input.remainingBudget ?? null,
    candidateLineage: lineage,
    strongestCandidateId: strongest?.id,
    latestVerification: summarizeVerification(latestVerification),
    latestSignalSnapshotId: input.latestSignalSnapshot?.id,
    verifiedFacts: input.knowledge
      .filter((record) => record.kind === "FACT")
      .map((record) => record.statement),
    decisions: input.knowledge
      .filter((record) => record.kind === "DECISION")
      .map((record) => record.statement),
    recoveryReason: input.recoveryReason,
    recoveryDetail: input.recoveryDetail,
    createdAt: input.now ?? new Date().toISOString(),
  };
};
