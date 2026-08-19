export interface ProjectPreferences {
  providerPreference?: string | undefined;
  qualityPreference?: "FAST" | "BALANCED" | "HIGH" | "CRITICAL" | undefined;
  budgetPreference?: "AUTO" | "CUSTOM" | undefined;
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
}
