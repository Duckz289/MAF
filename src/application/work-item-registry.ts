import {
  assertWorkItemCannotMutateTrust,
  type WorkItem,
  type WorkItemMutation,
  type WorkItemPriority,
  type WorkItemProvider,
  type WorkItemStatus,
} from "../domain/work";

const now = (): string => new Date().toISOString();

const boundedText = (label: string, value: string, max: number): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new Error(`${label} must contain between 1 and ${max} characters`);
  }
  return trimmed;
};

/**
 * Built-in MAF work-item store. Coordinates human work; it cannot write trust or verification.
 */
export class BuiltInWorkItemRegistry implements WorkItemProvider {
  readonly id = "MAF_BUILTIN" as const;
  private readonly items = new Map<string, WorkItem>();

  async list(projectId: string | undefined): Promise<WorkItem[]> {
    return [...this.items.values()]
      .filter((item) => projectId === undefined || item.projectId === projectId)
      .map((item) => structuredClone(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string): Promise<WorkItem | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async apply(mutation: WorkItemMutation): Promise<WorkItem> {
    assertWorkItemCannotMutateTrust(mutation);
    if (mutation.type === "CREATE") {
      const created: WorkItem = {
        id: crypto.randomUUID(),
        projectId: boundedText("Work item project", mutation.projectId, 200),
        title: boundedText("Work item title", mutation.title, 240),
        description: mutation.description?.trim() ?? "",
        status: "BACKLOG",
        priority: mutation.priority ?? "UNSET",
        owner: mutation.owner?.trim() || null,
        milestone: mutation.milestone?.trim() || null,
        dependencyIds: [...new Set(mutation.dependencyIds ?? [])],
        runId: null,
        taskId: null,
        provider: "MAF_BUILTIN",
        externalRef: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.items.set(created.id, created);
      return structuredClone(created);
    }
    const existing = this.items.get(mutation.id);
    if (!existing) throw new Error(`Unknown work item: ${mutation.id}`);
    if (mutation.type === "LINK_EXECUTION") {
      const updated: WorkItem = {
        ...existing,
        runId: boundedText("Work item run", mutation.runId, 200),
        taskId: boundedText("Work item task", mutation.taskId, 200),
        status:
          existing.status === "BACKLOG" || existing.status === "READY"
            ? "IN_PROGRESS"
            : existing.status,
        updatedAt: now(),
      };
      this.items.set(updated.id, updated);
      return structuredClone(updated);
    }
    const status: WorkItemStatus = mutation.status ?? existing.status;
    const priority: WorkItemPriority = mutation.priority ?? existing.priority;
    const updated: WorkItem = {
      ...existing,
      title:
        mutation.title !== undefined
          ? boundedText("Work item title", mutation.title, 240)
          : existing.title,
      description:
        mutation.description !== undefined ? mutation.description.trim() : existing.description,
      status,
      priority,
      owner: mutation.owner !== undefined ? mutation.owner?.trim() || null : existing.owner,
      milestone:
        mutation.milestone !== undefined ? mutation.milestone?.trim() || null : existing.milestone,
      dependencyIds: mutation.dependencyIds ?? existing.dependencyIds,
      updatedAt: now(),
    };
    this.items.set(updated.id, updated);
    return structuredClone(updated);
  }
}
