export type Navigate = (path: string) => void;

export type RunState = "QUEUED" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface Run {
  id: string;
  state: RunState;
  executionMode: "STRICT" | "GUIDED" | "SOLO_NATIVE";
  verificationState: string;
  trustState?: string;
  agent: string;
  model: string;
  provider: string;
  repositoryPath: string;
  revision: string;
  updatedAt: string;
  changedFiles: string[];
  error?: string;
  cost: {
    total: number;
    model?: number;
    sandbox?: number;
    verification?: number;
    retry?: number;
    recovery?: number;
  };
  task: string;
  currentPhase: string;
  desiredMode: "STRICT" | "GUIDED" | "SOLO_NATIVE";
  effectiveMode: "STRICT" | "GUIDED" | "SOLO_NATIVE";
  modeExplanation: {
    reason: string;
    desiredMode: string;
    effectiveMode: string;
    pendingEnforcement?: { toDesired: string; method: string; requestedAt: string };
    latestSnapshotId?: string;
    latestSignals: Record<string, { value: number | boolean; source: string; reliability: string }>;
    timeline: Array<{
      from: string;
      to: string;
      reason: string;
      timestamp: string;
      enforcement?: string;
    }>;
  };
  operationalStatus: string;
  strategyObservationBinding?: {
    verifiedSuccess: boolean;
    costUsd: number | null;
    latencyMs: number;
    retries: number;
    qualityOutcome: "PASS" | "FAIL" | "UNKNOWN";
    security: "PASS" | "FAIL" | "NOT_CHECKED" | "NOT_REQUIRED";
    performance: "PASS" | "FAIL" | "NOT_CHECKED" | "NOT_REQUIRED";
    resilience: "PASS" | "FAIL" | "NOT_CHECKED" | "NOT_REQUIRED";
    healthEffect: "STABLE" | "DEGRADING" | "UNKNOWN";
  };
}

export interface Project {
  id: string;
  name: string;
  repositoryPath: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  preferences: {
    qualityPreference?: string;
    budgetPreference?: string;
    providerPreference?: string;
  };
}

export interface Connection {
  id: string;
  category: "AI_PROVIDER" | "MAF_ACCOUNT";
  provider: string;
  method: string;
  status: string;
  capability: string;
  credentialReference?: string;
  detail: string;
  credentialSources?: Array<{
    id: "ENVIRONMENT" | "LOCAL_ENCRYPTED_VAULT" | "OAUTH_PKCE";
    label: string;
    available: boolean;
    detail: string;
  }>;
}

export interface Agent {
  id: string;
  name: string;
  available: boolean;
  active: boolean;
  authMethod: string;
  detail: string;
}

export interface HomeData {
  active: Run[];
  attention: Run[];
  recent: Run[];
  usage: { totalRecorded: number; hasKnownCost: boolean; currency: string };
}

export interface PlatformKey {
  id: string;
  scopes: string[];
  revoked: boolean;
  createdAt: string;
}

export interface ConnectionTestResult {
  status?: string;
  detail?: string;
  message?: string;
  lastCheckedAt?: string;
}

export interface QualityCheckResult {
  state: "PASS" | "WARN" | "FAIL" | "UNKNOWN" | "NOT_CHECKED" | "NOT_REQUIRED";
  evidence: string[];
  provenance: "DETERMINISTIC" | "MEASURED" | "PENDING_CHECKER";
}

export type QualityReport = Record<string, QualityCheckResult>;

export interface RiskValue {
  level: "LOW" | "MEDIUM" | "HIGH";
  provenance: "DETERMINISTIC" | "HEURISTIC" | "INSUFFICIENT_EVIDENCE";
  evidence: string[];
}

export type RiskVector = Record<string, RiskValue>;

export interface AssurancePlan {
  required: string[];
  notRequired: string[];
  reasons: Record<string, string>;
}

export interface RecoveryCapsule {
  runId: string;
  goal: string;
  repositoryPath: string;
  agent: string;
  model: string;
  provider: string;
  desiredMode: string;
  effectiveMode: string;
  costSpent: { total: number };
  remainingBudget: number | null;
  strongestCandidateId?: string;
  verifiedFacts: string[];
  decisions: string[];
  recoveryReason: string;
  recoveryDetail: string;
  createdAt: string;
}

export interface DeliveryDecision {
  handoff: {
    candidateQuality: "READY" | "BLOCKED";
    knownWarnings: Array<{ dimension: string; state: string }>;
    budget: { mode: "ADVISORY" | "HARD"; limitUsd: number | null; recordedCostUsd: number };
    changedFiles: string[];
  };
  candidateQuality: "READY" | "BLOCKED";
  ciStatus: string;
  ciHeadRevision: string | null;
  mergeEligibility: "ELIGIBLE" | "PENDING" | "BLOCKED";
  mergeAuthority: "EXTERNAL_APPROVAL_REQUIRED";
  autoMergeAllowed: false;
  reasons: string[];
}

export interface HealthTrendMetric {
  metric: string;
  group: "structural" | "change" | "operational";
  previous: number | null;
  current: number | null;
  direction: "IMPROVING" | "DEGRADING" | "FLAT" | "UNKNOWN";
  note?: string;
}

export interface HealthLedger {
  samples: Array<{ timestamp: string; runId: string }>;
  trend?: { incomplete: boolean; metrics: HealthTrendMetric[] };
  maintenance?: { needed: boolean; reasons: string[]; escalationCorrelationNote?: string };
  productionImpact: {
    state: "UNKNOWN" | "STABLE" | "DEGRADING";
    strategyDemotionRequired: boolean;
    maintenanceRecommended: boolean;
    reasons: string[];
  };
}

export type DecisionItem =
  | {
      type: "RECOVERY";
      runId: string;
      task: string;
      repositoryPath: string;
      updatedAt: string;
      recoveryReason: string;
      recoveryDetail?: string;
      remainingBudget: number | null;
      costSpent: number;
    }
  | {
      type: "ASSURANCE_BLOCKED";
      runId: string;
      task: string;
      repositoryPath: string;
      updatedAt: string;
    }
  | {
      type: "AWAITING_REVIEW";
      runId: string;
      task: string;
      repositoryPath: string;
      updatedAt: string;
    }
  | {
      type: "DELIVERY";
      runId: string;
      task: string;
      repositoryPath: string;
      updatedAt: string;
      mergeEligibility: "ELIGIBLE" | "BLOCKED";
      knownWarnings: Array<{ dimension: string; state: string }>;
    };
