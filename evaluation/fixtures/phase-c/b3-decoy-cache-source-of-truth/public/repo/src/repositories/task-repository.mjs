const tasks = new Map();

export const taskRepository = {
  save(task) {
    tasks.set(task.id, task);
    return task;
  },
  get(id) {
    return tasks.get(id) ?? null;
  },
  listByProject(projectId) {
    return Array.from(tasks.values()).filter((t) => t.projectId === projectId);
  },
  all() {
    return Array.from(tasks.values());
  },
};
