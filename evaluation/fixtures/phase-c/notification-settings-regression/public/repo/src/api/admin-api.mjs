import { forceCloseTask } from "../admin/admin-task-controller.mjs";
import { buildAdminSummary } from "../admin/admin-report.mjs";

export function handleForceCloseTask(taskId) {
  return forceCloseTask(taskId);
}

export function handleAdminSummary(projectId) {
  return buildAdminSummary(projectId);
}
