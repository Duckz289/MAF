import { createTask } from "../services/task-service.mjs";

export function createTaskCommand(projectId, title) {
  return createTask(projectId, title);
}
