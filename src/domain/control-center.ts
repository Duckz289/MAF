/**
 * Engineering Control Center read-model contracts.
 *
 * These types are derived projections for human inspection. They are not authority:
 * they cannot grant trust, close obligations, or change mission policy. Graph edges
 * are navigation, not proof.
 */
import type { ContextBudget, ContextFreshness } from "./context";
import type { KnowledgeKind, KnowledgeResolutionState } from "./ports";
import type { CostBreakdown, Event, ExecutionMode, RunState, TrustState } from "./types";

export const CONTROL_CENTER_PAGE = Object.freeze({
  defaultLimit: 40,
  maxLimit: 100,
  mapModules: 24,
  mapFilesPerModule: 12,
  mapRelations: 40,
  mapScopeFiles: 12,
  mapNeighborhood: 16,
  eventPreviewChars: 800,
  evidencePreviewChars: 600,
  knowledgePage: 40,
});

export type InspectionDepth = "SIMPLE" | "ADVANCED" | "INSPECT";

export type VisualAuthority =
  | "DETERMINISTIC"
  | "DETERMINISTIC_STRUCTURE"
  | "CONTEXT_ONLY"
  | "VERIFIED"
  | "INFERENCE"
  | "STALE"
  | "CONFLICTED"
  | "UNKNOWN";

export type CheckOutcomeStatus =
  | "PASS"
  | "FAIL"
  | "WARN"
  | "UNKNOWN"
  | "NOT_CHECKED"
  | "NOT_EXECUTED"
  | "UNSUPPORTED"
  | "NOT_REQUIRED"
  | "NOT_APPLICABLE";

export type PresentationTone = "success" | "danger" | "warning" | "informative" | "subtle";

export type MonetaryPresentationStatus =
  | "EXACT"
  | "ESTIMATED"
  | "SUBSCRIPTION_INCLUDED"
  | "UNKNOWN";

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

export interface PageResult<T> {
  items: T[];
  limit: number;
  truncated: boolean;
  nextCursor: string | null;
}

export const boundPageLimit = (limit: number | undefined): number => {
  if (limit === undefined) return CONTROL_CENTER_PAGE.defaultLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Page limit must be a positive integer");
  }
  return Math.min(limit, CONTROL_CENTER_PAGE.maxLimit);
};

export const paginateItems = <T>(items: readonly T[], query: PageQuery = {}): PageResult<T> => {
  const limit = boundPageLimit(query.limit);
  const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Page cursor must be a non-negative integer");
  }
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: [...slice],
    limit,
    truncated: nextOffset < items.length,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
  };
};

export const checkOutcomeTone = (status: string | undefined): PresentationTone => {
  if (status === "PASS" || status === "VERIFIED" || status === "MERGE_ELIGIBLE") return "success";
  if (status === "FAIL" || status === "BLOCKED" || status === "QUARANTINED") return "danger";
  if (status === "WARN") return "warning";
  if (status === "PENDING" || status === "VERIFYING" || status === "RUNNING") return "informative";
  return "subtle";
};

export const checkOutcomeLabel = (status: string | undefined): string => {
  switch (status) {
    case "PASS":
      return "Pass";
    case "FAIL":
      return "Fail";
    case "WARN":
      return "Warning";
    case "UNKNOWN":
      return "Unknown";
    case "NOT_CHECKED":
    case "NOT_EXECUTED":
      return "Not executed";
    case "UNSUPPORTED":
      return "Unsupported";
    case "NOT_REQUIRED":
      return "Not required";
    case "NOT_APPLICABLE":
      return "Not applicable";
    case "VERIFIED":
      return "Verified";
    default:
      return status && status.length > 0 ? status : "Unknown";
  }
};

/** UNKNOWN / NOT_EXECUTED must never collapse into PASS for UI or API consumers. */
export const isPassingCheck = (status: string | undefined): boolean => status === "PASS";

export const visualAuthorityTone = (authority: VisualAuthority): PresentationTone => {
  if (authority === "VERIFIED") return "success";
  if (authority === "DETERMINISTIC" || authority === "DETERMINISTIC_STRUCTURE") {
    return "informative";
  }
  if (authority === "STALE" || authority === "CONFLICTED") return "warning";
  return "subtle";
};

export const knowledgeVisualAuthority = (
  kind: KnowledgeKind,
  resolution: KnowledgeResolutionState,
): VisualAuthority => {
  if (resolution === "STALE") return "STALE";
  if (resolution === "CONFLICTED") return "CONFLICTED";
  if (resolution === "UNKNOWN") return "UNKNOWN";
  if (kind === "INFERENCE") return "INFERENCE";
  if (kind === "EVIDENCE" || kind === "FACT") return "DETERMINISTIC";
  return "DETERMINISTIC";
};

export interface MonetaryPresentation {
  status: MonetaryPresentationStatus;
  amountUsd: number | null;
  display: string;
  source: string | null;
}

export const formatMonetaryDisplay = (
  status: MonetaryPresentationStatus,
  amountUsd: number | null,
): string => {
  if (status === "UNKNOWN") return "unknown";
  if (status === "SUBSCRIPTION_INCLUDED") return "included in subscription";
  if (amountUsd === null) return "unknown";
  const formatted = `$${amountUsd.toFixed(2)}`;
  return status === "ESTIMATED" ? `~${formatted}` : formatted;
};

export const presentMonetary = (
  status: MonetaryPresentationStatus,
  amountUsd: number | null,
  source: string | null = null,
): MonetaryPresentation => ({
  status,
  amountUsd: status === "UNKNOWN" || status === "SUBSCRIPTION_INCLUDED" ? null : amountUsd,
  display: formatMonetaryDisplay(status, amountUsd),
  source,
});

export interface CostComponentPresentation {
  id: "model" | "context" | "retry" | "verification" | "recovery" | "sandbox";
  monetary: MonetaryPresentation;
}

export interface CostPresentation {
  total: MonetaryPresentation;
  knownSubtotalUsd: number;
  unknownComponentCount: number;
  components: CostComponentPresentation[];
  /** Absent until a DVS evaluation series exists. Never inferred from run cost. */
  costPerDurableVerifiedSuccess: null;
}

const component = (
  id: CostComponentPresentation["id"],
  amount: number,
  unknownWhenZero: boolean,
): CostComponentPresentation => {
  if (unknownWhenZero && amount === 0) {
    return { id, monetary: presentMonetary("UNKNOWN", null, `${id} not recorded`) };
  }
  return { id, monetary: presentMonetary("ESTIMATED", amount, `${id} run ledger`) };
};

/**
 * Existing Run.cost uses numeric zeros as "not recorded". CanonicalCostRecord uses an explicit
 * UNKNOWN status. This projection never renders UNKNOWN as "$0".
 */
export const presentCostBreakdown = (cost: CostBreakdown): CostPresentation => {
  const components = [
    component("model", cost.model, cost.model === 0),
    component("sandbox", cost.sandbox, cost.sandbox === 0),
    component("context", 0, true),
    component("retry", cost.retry, cost.retry === 0),
    component("verification", cost.verification, cost.verification === 0),
    component("recovery", cost.recovery, cost.recovery === 0),
  ];
  const unknownComponentCount = components.filter(
    (entry) => entry.monetary.status === "UNKNOWN",
  ).length;
  const knownSubtotalUsd =
    cost.model + cost.sandbox + cost.verification + cost.retry + cost.recovery;
  return {
    total:
      unknownComponentCount > 0
        ? presentMonetary("UNKNOWN", null, "one or more cost components were not recorded")
        : presentMonetary("ESTIMATED", knownSubtotalUsd, "run cost ledger"),
    knownSubtotalUsd,
    unknownComponentCount,
    components,
    costPerDurableVerifiedSuccess: null,
  };
};

export const presentCanonicalMonetary = (input: {
  status: MonetaryPresentationStatus;
  amountUsd: number | null;
  knownSubtotalUsd: number;
  unknownComponentCount: number;
  source?: string | null;
  components?: CostComponentPresentation[];
}): CostPresentation => {
  const unknown = input.unknownComponentCount > 0 || input.status === "UNKNOWN";
  const status: MonetaryPresentationStatus = unknown ? "UNKNOWN" : input.status;
  const amountUsd =
    status === "UNKNOWN" || status === "SUBSCRIPTION_INCLUDED" ? null : input.amountUsd;
  return {
    total: presentMonetary(status, amountUsd, input.source ?? null),
    knownSubtotalUsd: input.knownSubtotalUsd,
    unknownComponentCount: input.unknownComponentCount,
    components: input.components ?? [],
    costPerDurableVerifiedSuccess: null,
  };
};

export interface WhyRecord {
  id: string;
  question:
    | "WHY_MODE"
    | "WHY_MODEL"
    | "WHY_SKILL"
    | "WHY_CONTEXT_EXPANSION"
    | "WHY_MISSION_BLOCKED"
    | "WHY_MERGE_NOT_ELIGIBLE"
    | "WHY_BUDGET"
    | "WHY_RECOVERY"
    | "WHY_MISSION_CONTRACT";
  eventType: string;
  eventId: string;
  timestamp: string;
  reason: string;
  evidenceIds: string[];
  /** Provenance is recorded decision/event data, never a post-hoc LLM explanation. */
  provenance: "RECORDED_EVENT";
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export const deriveWhyRecords = (events: readonly Event<unknown>[]): WhyRecord[] => {
  const records: WhyRecord[] = [];
  for (const event of events) {
    const data = asRecord(event.data);
    if (event.type === "ModeChanged" || event.type === "ModeChangeRequested") {
      const from = asString(data.from) ?? asString(data.fromDesired) ?? "UNKNOWN";
      const to = asString(data.to) ?? asString(data.toDesired) ?? "UNKNOWN";
      records.push({
        id: `why-mode-${event.id}`,
        question: "WHY_MODE",
        eventType: event.type,
        eventId: event.id,
        timestamp: event.timestamp,
        reason: asString(data.reason) ?? `Mode ${from} → ${to}`,
        evidenceIds: asStringArray(data.evidenceIds),
        provenance: "RECORDED_EVENT",
      });
    }
    if (event.type === "MissionCompiled") {
      records.push({
        id: `why-mission-${event.id}`,
        question: "WHY_MISSION_CONTRACT",
        eventType: event.type,
        eventId: event.id,
        timestamp: event.timestamp,
        reason: `Mission ${asString(data.missionId) ?? "unknown"} compiled; denied authority ${asStringArray(data.deniedAuthority).join(", ") || "none"}`,
        evidenceIds: asString(data.missionDigest) ? [data.missionDigest as string] : [],
        provenance: "RECORDED_EVENT",
      });
    }
    if (event.type === "PromptCompiled") {
      const model = asRecord(data.modelTarget);
      records.push({
        id: `why-model-${event.id}`,
        question: "WHY_MODEL",
        eventType: event.type,
        eventId: event.id,
        timestamp: event.timestamp,
        reason: `Prompt compiled for ${asString(model.provider) ?? "unknown"}/${asString(model.model) ?? "unknown"} (template ${asString(data.templateVersion) ?? "unknown"})`,
        evidenceIds: asString(data.promptArtifactId) ? [data.promptArtifactId as string] : [],
        provenance: "RECORDED_EVENT",
      });
    }
    if (event.type === "AgentSkillsSelected") {
      const selections = Array.isArray(data.selections) ? data.selections : [];
      for (const [index, selection] of selections.entries()) {
        const row = asRecord(selection);
        records.push({
          id: `why-skill-${event.id}-${index}`,
          question: "WHY_SKILL",
          eventType: event.type,
          eventId: event.id,
          timestamp: event.timestamp,
          reason: `${asString(row.skillId) ?? "skill"} ${asString(row.status) ?? "UNKNOWN"}: ${asString(row.reason) ?? "no recorded reason"}`,
          evidenceIds: asString(row.packageDigest) ? [row.packageDigest as string] : [],
          provenance: "RECORDED_EVENT",
        });
      }
    }
    if (
      event.type === "ContextExpanded" ||
      event.type === "ContextPageRejected" ||
      event.type === "ContextLedgerRecorded"
    ) {
      records.push({
        id: `why-context-${event.id}`,
        question: "WHY_CONTEXT_EXPANSION",
        eventType: event.type,
        eventId: event.id,
        timestamp: event.timestamp,
        reason:
          asString(data.reason) ??
          (event.type === "ContextLedgerRecorded"
            ? `Context ledger recorded at ${asString(data.buildStage) ?? "unknown stage"}`
            : event.type),
        evidenceIds: [],
        provenance: "RECORDED_EVENT",
      });
    }
    if (event.type === "QualityAssessed") {
      const unresolved = asStringArray(data.unresolvedObligations);
      const trust = asString(data.trustState);
      if (trust !== "MERGE_ELIGIBLE") {
        records.push({
          id: `why-merge-${event.id}`,
          question: "WHY_MERGE_NOT_ELIGIBLE",
          eventType: event.type,
          eventId: event.id,
          timestamp: event.timestamp,
          reason:
            unresolved.length > 0
              ? `Trust ${trust ?? "UNKNOWN"}; unresolved obligations: ${unresolved.join(", ")}`
              : `Trust ${trust ?? "UNKNOWN"}; merge is not eligible`,
          evidenceIds: asString(data.candidateId) ? [data.candidateId as string] : [],
          provenance: "RECORDED_EVENT",
        });
      }
    }
    if (event.type === "RunPaused" || event.type === "RunFailed") {
      records.push({
        id: `why-blocked-${event.id}`,
        question: "WHY_MISSION_BLOCKED",
        eventType: event.type,
        eventId: event.id,
        timestamp: event.timestamp,
        reason: asString(data.reason) ?? asString(data.error) ?? event.type,
        evidenceIds: [],
        provenance: "RECORDED_EVENT",
      });
    }
    if (event.type === "RecoveryAttempted" || event.type === "BudgetAllocated") {
      records.push({
        id: `why-ops-${event.id}`,
        question: event.type === "BudgetAllocated" ? "WHY_BUDGET" : "WHY_RECOVERY",
        eventType: event.type,
        eventId: event.id,
        timestamp: event.timestamp,
        reason:
          event.type === "BudgetAllocated"
            ? `Budget ${asString(data.mode) ?? "ADVISORY"}; configured=${String(data.configured === true)}`
            : (asString(data.reason) ?? "Recovery attempted"),
        evidenceIds: [],
        provenance: "RECORDED_EVENT",
      });
    }
  }
  return records;
};

export interface TrustDerivationStep {
  stage: "CANDIDATE" | "VERIFICATION" | "EVIDENCE" | "OBLIGATIONS" | "TRUST_STATE";
  status: string;
  detail: string;
  authority: VisualAuthority;
}

export interface ObligationInspection {
  id: string;
  status: CheckOutcomeStatus;
  label: string;
  tone: PresentationTone;
  capabilityId: string | null;
  justification: string | null;
}

export interface KnowledgeSummary {
  examined: number;
  current: number;
  stale: number;
  unknown: number;
  conflicted: number;
  truncated: boolean;
}

export interface KnowledgeInspectionRecord {
  id: string;
  kind: KnowledgeKind;
  statement: string;
  resolution: KnowledgeResolutionState;
  authority: VisualAuthority;
  producer: string;
  source: string;
  revision: string;
  evidenceIds: string[];
}

export interface OptionalProviderStatus {
  id: string;
  name: string;
  kind:
    | "DEPENDENCY_VULNERABILITY"
    | "STATIC_ANALYSIS"
    | "REPOSITORY_INTELLIGENCE"
    | "OBSERVABILITY_EXPORT"
    | "MODEL_PRICING";
  availability: "AVAILABLE" | "UNAVAILABLE" | "NOT_CONFIGURED" | "FAILED";
  version: string | null;
  scope: string;
  lastExecution: string | null;
  failure: string | null;
  coverageLimitations: string[];
  /** Optional providers never imply the Engineering Control Center is unhealthy. */
  systemHealthImpact: "NONE";
}

export interface ProjectMapNode {
  id: string;
  kind: "MODULE" | "PACKAGE" | "FILE" | "SYMBOL" | "KNOWLEDGE";
  label: string;
  path: string | null;
  authority: VisualAuthority;
  flags: Array<
    "ACTIVE_MISSION" | "CHANGED" | "STALE_KNOWLEDGE" | "CONFLICTED_KNOWLEDGE" | "RECENT_FAILURE"
  >;
  childCount: number;
}

export interface ProjectMapEdge {
  from: string;
  to: string;
  kind: "CONTAINS" | "IMPORTS" | "REFERENCES" | "IMPLEMENTS";
  authority: VisualAuthority;
  /** Navigation only. Never treated as trust or blast-radius proof. */
  trustAuthority: "NONE";
}

export interface ProjectMapReadModel {
  projectId: string;
  revision: string;
  source: "REPOSITORY_INDEX" | "PROJECT_BRAIN" | "REPOSITORY_INTELLIGENCE";
  focus: string | null;
  nodes: ProjectMapNode[];
  edges: ProjectMapEdge[];
  knowledge: KnowledgeSummary;
  truncated: boolean;
  nextCursor: string | null;
  filesTruncated: boolean;
  neighborhood: {
    available: boolean;
    status: "NOT_REQUESTED" | "UNAVAILABLE" | "BOUNDED" | "FAILED";
    reason: string;
    truncated: boolean;
  };
}

export interface ContextInspection {
  initialWorkingSet: {
    files: string[];
    modules: string[];
    truncated: boolean;
  };
  residentPages: number;
  handleCount: number;
  requestCount: number;
  pageCount: number;
  budget: ContextBudget | null;
  measuredCharacters: number | null;
  estimatedTokens: number | null;
  expansionEvents: number;
  reuseEvents: number;
  staleRejections: number;
  exhaustion: string | null;
  freshness: ContextFreshness;
  latestLedgerStage: string | null;
}

export interface CandidateInspection {
  id: string;
  digest: string | null;
  attempt: number | null;
  changedFiles: string[];
  identityAuthority: VisualAuthority;
}

export interface SimpleMissionReadModel {
  depth: "SIMPLE";
  runId: string;
  projectId: string | null;
  objective: string;
  status: RunState;
  operationalStatus: string;
  selectedAgent: string;
  selectedModel: string;
  interventionMode: ExecutionMode;
  budget: { mode: "ADVISORY" | "HARD"; configured: boolean; limitUsd: number | null };
  cost: CostPresentation;
  verification: { state: string; label: string; tone: PresentationTone };
  trust: { state: TrustState | "UNKNOWN"; label: string; tone: PresentationTone };
}

export interface AdvancedMissionReadModel extends Omit<SimpleMissionReadModel, "depth"> {
  depth: "ADVANCED";
  desiredMode: ExecutionMode;
  effectiveMode: ExecutionMode;
  skills: Array<{ skillId: string; status: string; reason: string }>;
  risk: Record<string, { level: string; provenance: string }> | null;
  coupling: { level: string; provenance: string } | null;
  strategy: { binding: string | null; observationId: string | null };
  contextPolicy: { authority: "CONTEXT_OS"; expansion: string };
  sandbox: { present: boolean };
  providers: OptionalProviderStatus[];
  verificationDetail: { attempts: number; latestState: string };
}

export interface InspectMissionReadModel extends Omit<AdvancedMissionReadModel, "depth"> {
  depth: "INSPECT";
  missionContract: {
    id: string;
    digest: string;
    deniedAuthority: string[];
    grantedAuthority: string[];
    ambiguities: string[];
  } | null;
  candidate: CandidateInspection | null;
  trustDerivation: TrustDerivationStep[];
  obligations: ObligationInspection[];
  context: ContextInspection;
  why: WhyRecord[];
  prompt: { templateVersion: string | null; policyVersion: string | null; skillVersions: string[] };
  recovery: { present: boolean; classification: string | null };
  evolution: { challengerPresent: boolean; baseline: string | null };
  knowledge: KnowledgeSummary;
}

export type MissionReadModel =
  | SimpleMissionReadModel
  | AdvancedMissionReadModel
  | InspectMissionReadModel;

export interface ProjectSummaryReadModel {
  id: string;
  name: string;
  revision: string;
  repositoryPresent: boolean;
  activeRuns: number;
  blockedRuns: number;
  knowledge: KnowledgeSummary;
  providers: OptionalProviderStatus[];
}

export interface ControlCenterOverview {
  product: "ENGINEERING_CONTROL_CENTER";
  emergencyStop: boolean;
  projects: number;
  missionTrees: number;
  activeRuns: number;
  attention: number;
  knowledge: KnowledgeSummary;
  cost: CostPresentation;
  providers: OptionalProviderStatus[];
}

export interface EvolutionInspection {
  productionBaseline: { id: string; class: string; version: string } | null;
  challenger: { id: string; class: string; lifecycle: string } | null;
  evaluationLineage: Array<{ id: string; stage: string; result: string }>;
  frozenSuite: { id: string; digest: string } | null;
  shadowStatus: "NOT_RUNNING" | "SHADOW" | "UNKNOWN";
  promotion: "NOT_DECIDED" | "PROMOTED" | "REJECTED" | "NONE_RECORDED";
  optimizeProductionPolicyAvailable: false;
}

export interface EventInspection {
  id: string;
  type: string;
  timestamp: string;
  summary: string;
}

export interface EvidenceInspection {
  id: string;
  kind: "VERIFICATION" | "OBLIGATION" | "QUALITY" | "PROVIDER" | "RUNTIME_SIGNAL";
  status: string;
  tone: PresentationTone;
  summary: string;
  authority: VisualAuthority;
}
