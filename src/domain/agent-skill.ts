import type { AuthorityCapability } from "./mission";
import type { MonetaryCost } from "./model-intelligence";

export type SkillLifecycle = "CANDIDATE" | "EVALUATED" | "PRODUCTION" | "STALE" | "REVOKED";

export interface AgentSkillBinding {
  skillId: string;
  declaredVersion: string;
  certifiedPackageDigest: string | null;
  source: string;
  compatibility: string[];
  applicableTaskClasses: string[];
  applicableRisk: Array<"LOW" | "MEDIUM" | "HIGH">;
  expectedCost: MonetaryCost;
  requiredEvidence: string[];
  allowedAuthority: AuthorityCapability[];
  lifecycle: SkillLifecycle;
}

/** Discovery metadata only. It never contains the SKILL.md body or resource contents. */
export interface AgentSkillDiscovery {
  id: string;
  name: string;
  description: string;
  packageDigest: string;
  declaredVersion: string;
  source: string;
  lifecycle: SkillLifecycle;
  resourcePaths: string[];
  packageRequestedTools: string[];
  binding: AgentSkillBinding;
}

export type SkillSelectionStatus =
  | "ACTIVATED"
  | "NOT_SELECTED"
  | "UNAVAILABLE"
  | "NOT_ELIGIBLE"
  | "REVOKED";

export interface AgentSkillSelection {
  skillId: string;
  status: SkillSelectionStatus;
  reason: string;
  discovery?: AgentSkillDiscovery;
  /** Present only after activation. Resource contents remain absent until loadResource(). */
  instructions?: string;
  effectiveAuthority: AuthorityCapability[];
}

export interface AgentSkillRegistryPort {
  discover(): Promise<AgentSkillDiscovery[]>;
  select(input: {
    skillIds: string[];
    missionAuthority: AuthorityCapability[];
    purpose: "PRODUCTION" | "EVALUATION";
  }): Promise<AgentSkillSelection[]>;
  loadResource(input: {
    skillId: string;
    resourcePath: string;
    maximumCharacters?: number;
  }): Promise<string>;
}
