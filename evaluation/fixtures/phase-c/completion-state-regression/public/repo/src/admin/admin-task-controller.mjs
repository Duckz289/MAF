import { taskRepository } from "../repositories/task-repository.mjs";
import { assertDefined } from "../utils/assert.mjs";

export function forceCloseTask(taskId) {
  assertDefined(taskId, "taskId is required");
  const task = taskRepository.get(taskId);
  if (!task) throw new Error("task not found");
  task.status = "FORCE_CLOSED";
  return taskRepository.save(task);
}
