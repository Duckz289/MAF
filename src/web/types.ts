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
  cost: { total: number };
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
