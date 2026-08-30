export interface ProjectPreferences {
  providerPreference?: string | undefined;
  qualityPreference?: "FAST" | "BALANCED" | "HIGH" | "CRITICAL" | undefined;
  budgetPreference?: "AUTO" | "CUSTOM" | undefined;
  /** Default execution mode applied to new tasks created from this project; AUTO defers to the
   * adaptive policy (see mode-controller.ts) rather than pinning a mode. */
  executionModePreference?: "AUTO" | "STRICT" | "GUIDED" | "SOLO_NATIVE" | undefined;
  /** Default per-task budget seeded into new runs' real BudgetPolicy (see budget.ts); undefined
   * means no project-level default is configured, not a zero limit. */
  budgetLimitUsd?: number | undefined;
  budgetMode?: "ADVISORY" | "HARD" | undefined;
}

export interface ProjectRecord {
  id: string;
  name: string;
  repositoryPath: string;
  revision: string;
  preferences: ProjectPreferences;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectRequest {
  name: string;
  repositoryPath: string;
  revision?: string;
  preferences?: ProjectPreferences;
}

/**
 * The V0 project catalogue intentionally has process-local durability only. It represents a local
 * workspace selection, not a cloud repository integration or a persistent project service.
 */
export class InMemoryProjectRegistry {
  private readonly projects = new Map<string, ProjectRecord>();

  list(): ProjectRecord[] {
    return [...this.projects.values()]
      .map((project) => structuredClone(project))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): ProjectRecord | undefined {
    const project = this.projects.get(id);
    return project ? structuredClone(project) : undefined;
  }

  create(request: CreateProjectRequest): ProjectRecord {
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: crypto.randomUUID(),
      name: request.name,
      repositoryPath: request.repositoryPath,
      revision: request.revision ?? "HEAD",
      preferences: request.preferences ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    return structuredClone(project);
  }

  /** Merges preferences (undefined fields in the patch leave the stored value unchanged). */
  update(id: string, preferencesPatch: ProjectPreferences): ProjectRecord | undefined {
    const existing = this.projects.get(id);
    if (!existing) return undefined;
    const updated: ProjectRecord = {
      ...existing,
      preferences: { ...existing.preferences, ...preferencesPatch },
      updatedAt: new Date().toISOString(),
    };
    this.projects.set(id, updated);
    return structuredClone(updated);
  }
}
