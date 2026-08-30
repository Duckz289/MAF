export function makeTask(id, projectId, title) {
  return { id, projectId, title, status: "OPEN", assigneeId: null, completedAt: null };
}
