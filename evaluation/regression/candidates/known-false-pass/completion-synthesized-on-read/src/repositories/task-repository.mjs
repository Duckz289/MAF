const tasks = new Map();
const completionOverlay = new Map();

export const taskRepository = {
  save(task) {
    tasks.set(task.id, task);
    return task;
  },
  get(id) {
    const stored = tasks.get(id) ?? null;
    if (!stored) return null;
    const overlay = completionOverlay.get(id);
    return overlay ? { ...stored, ...overlay } : stored;
  },
  markCompletedForRead(id, completedAt) {
    completionOverlay.set(id, { status: "COMPLETED", completedAt });
  },
  listByProject(projectId) {
    return Array.from(tasks.values()).filter((t) => t.projectId === projectId);
  },
  all() {
    return Array.from(tasks.values());
  },
};
