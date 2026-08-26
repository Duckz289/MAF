/**
 * Minimum project-management layer for the Engineering Control Center.
 *
 * External PM systems (GitHub Issues, Plane, Linear, Jira) may supply work-item
 * coordination state. They do not determine MAF authority, trust, verification,
 * or execution policy. Plane-specific types are not imported.
 */

export const WORK_ITEM_STATUSES = [
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
  "CANCELLED",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_PRIORITIES = ["UNSET", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const WORK_ITEM_PROVIDERS = [
  "MAF_BUILTIN",
  "GITHUB_ISSUES",
  "PLANE",
  "LINEAR",
  "JIRA",
] as const;

export type WorkItemProviderId = (typeof WORK_ITEM_PROVIDERS)[number];

/** Fields a PM provider is never allowed to write. Trust remains MAF-owned. */
export const WORK_ITEM_FORBIDDEN_AUTHORITY_FIELDS = [
  "trustState",
  "trust",
  "verificationState",
  "verification",
  "assurance",
  "obligations",
  "mergeEligibility",
  "mergeAuthority",
  "promotion",
  "candidateId",
  "qualityReport",
] as const;

export type WorkItemForbiddenAuthorityField = (typeof WORK_ITEM_FORBIDDEN_AUTHORITY_FIELDS)[number];

export interface WorkItemExternalRef {
  provider: Exclude<WorkItemProviderId, "MAF_BUILTIN">;
  id: string;
  url: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  owner: string | null;
  milestone: string | null;
  dependencyIds: string[];
  runId: string | null;
  taskId: string | null;
  provider: WorkItemProviderId;
  externalRef: WorkItemExternalRef | null;
  updatedAt: string;
  createdAt: string;
}

export type WorkItemMutation =
  | {
      type: "CREATE";
      projectId: string;
      title: string;
      description?: string;
      priority?: WorkItemPriority;
      owner?: string | null;
      milestone?: string | null;
      dependencyIds?: string[];
    }
  | {
      type: "UPDATE";
      id: string;
      title?: string;
      description?: string;
      status?: WorkItemStatus;
      priority?: WorkItemPriority;
      owner?: string | null;
      milestone?: string | null;
      dependencyIds?: string[];
    }
  | {
      type: "LINK_EXECUTION";
      id: string;
      runId: string;
      taskId: string;
    };

export interface WorkItemProvider {
  readonly id: WorkItemProviderId;
  list(projectId: string | undefined): Promise<WorkItem[]>;
  get(id: string): Promise<WorkItem | undefined>;
  apply(mutation: WorkItemMutation): Promise<WorkItem>;
}

const forbiddenKey = (key: string): boolean => {
  const normalized = key.trim();
  return (WORK_ITEM_FORBIDDEN_AUTHORITY_FIELDS as readonly string[]).includes(normalized);
};

/**
 * Structural guard: a PM payload cannot smuggle trust, verification, or promotion fields.
 * Used by the built-in provider and by any future generated-UI command envelope.
 */
export const assertWorkItemCannotMutateTrust = (input: unknown): void => {
  if (input === null || typeof input !== "object") return;
  const stack: unknown[] = [input];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (forbiddenKey(key)) {
        throw new Error(`Work-item provider cannot mutate engineering authority field "${key}"`);
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
};

export const GENERATED_UI_FORBIDDEN_COMMANDS = [
  "SET_TRUST",
  "PROMOTE_POLICY",
  "ALTER_MISSION_POLICY",
  "BYPASS_VERIFICATION",
  "ALTER_TRUST_CONSTITUTION",
  "MERGE_OR_DEPLOY",
] as const;

export interface GeneratedUiAction {
  source: "GENERATED_UI";
  command: string;
  payload: unknown;
}

/**
 * Session 9 does not ship generated UI. This seam is the command-policy round-trip
 * any future generated-UI action must pass; it cannot mutate trust or promotion.
 */
export const assertGeneratedUiCannotBypassCommandPolicy = (action: GeneratedUiAction): void => {
  if (action.source !== "GENERATED_UI") {
    throw new Error("Generated UI actions must declare source GENERATED_UI");
  }
  if ((GENERATED_UI_FORBIDDEN_COMMANDS as readonly string[]).includes(action.command)) {
    throw new Error("Generated UI cannot bypass MAF command policy");
  }
  assertWorkItemCannotMutateTrust(action.payload);
};
