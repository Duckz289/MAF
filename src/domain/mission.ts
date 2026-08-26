import type { QualityPreference } from "./assurance";
import type { ContextBudget } from "./context";
import type { ExecutionMode, VerificationSpec } from "./types";

export type AuthorityCapability =
  | "READ_BOUNDED_CONTEXT"
  | "REQUEST_CONTEXT_PAGE"
  | "READ_SANDBOX"
  | "WRITE_SANDBOX"
  | "RUN_SANDBOX_COMMAND"
  | "SUBMIT_CANDIDATE"
  | "ACCESS_RAW_CREDENTIALS"
  | "BYPASS_VERIFICATION"
  | "ALTER_TRUST_CONSTITUTION"
  | "SELF_PROMOTE_POLICY"
  | "MERGE_OR_DEPLOY";

export const defaultMissionAuthority = Object.freeze({
  granted: [
    "READ_BOUNDED_CONTEXT",
    "REQUEST_CONTEXT_PAGE",
    "READ_SANDBOX",
    "WRITE_SANDBOX",
    "RUN_SANDBOX_COMMAND",
    "SUBMIT_CANDIDATE",
  ] as AuthorityCapability[],
  denied: [
    "ACCESS_RAW_CREDENTIALS",
    "BYPASS_VERIFICATION",
    "ALTER_TRUST_CONSTITUTION",
    "SELF_PROMOTE_POLICY",
    "MERGE_OR_DEPLOY",
  ] as AuthorityCapability[],
});

export interface MissionContract {
  schemaVersion: 1;
  id: string;
  digest: string;
  objective: {
    text: string;
    source: "USER_REQUEST";
  };
  scope: {
    status: "EXPLICIT" | "UNSPECIFIED";
    repositoryPath: string;
    revision: string;
    paths: string[];
    exclusions: string[];
  };
  constraints: {
    status: "EXPLICIT" | "UNSPECIFIED";
    items: string[];
  };
  acceptanceCriteria: {
    status: "EXPLICIT" | "AMBIGUOUS" | "UNSPECIFIED";
    items: string[];
  };
  authority: {
    source: "MAF_POLICY";
    requested: AuthorityCapability[];
    granted: AuthorityCapability[];
    denied: AuthorityCapability[];
  };
  riskInputs: {
    complexity: "UNKNOWN";
    coupling: "UNKNOWN";
    source: "UNASSESSED_AT_COMPILATION";
  };
  budget:
    | { status: "UNSPECIFIED" }
    | { status: "CONFIGURED"; mode: "ADVISORY" | "HARD"; limitUsd: number };
  executionPolicy: {
    requestedMode: ExecutionMode | null;
    selectionAuthority: "MAF_POLICY";
    requiredAssuranceReducibleByBudgetOrModel: false;
  };
  verificationRequirements: {
    deterministicVerification: "REQUIRED";
    specificationStatus: "EXPLICIT" | "UNSPECIFIED";
    specification: VerificationSpec;
    expectedEvidence: string[];
  };
  contextPolicy: {
    authority: "CONTEXT_OS";
    expansion: "BOUNDED_PAGE_REQUESTS";
    requestedBudget: ContextBudget | null;
  };
  preferences: {
    quality: QualityPreference;
    model: string | null;
    skills: string[];
    authority: "USER_PREFERENCE_ONLY";
  };
  ambiguities: string[];
}

export interface MissionCompilationRequest {
  objective: string;
  repositoryPath: string;
  revision: string;
  requestedMode?: ExecutionMode;
  scopePaths?: string[];
  scopeExclusions?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  acceptanceCriteriaAmbiguous?: boolean;
  requestedAuthority?: AuthorityCapability[];
  budget?: { mode: "ADVISORY" | "HARD"; limitUsd: number };
  verification: VerificationSpec;
  expectedEvidence?: string[];
  contextBudget?: ContextBudget;
  qualityPreference?: QualityPreference;
  modelPreference?: string;
  skillIds?: string[];
}
