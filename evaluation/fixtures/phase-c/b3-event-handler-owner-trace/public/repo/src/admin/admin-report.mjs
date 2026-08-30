import { getProjectStats } from "../services/project-service.mjs";
import { taskRepository } from "../repositories/task-repository.mjs";
import { deepClone } from "../utils/deep-clone.mjs";

export function buildAdminSummary(projectId) {
  const stats = getProjectStats(projectId);
  const tasks = taskRepository.listByProject(projectId);
  return deepClone({ ...stats, taskCount: tasks.length });
}
