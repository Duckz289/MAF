import { completeTask } from "../services/task-service.mjs";
import { eventBus } from "../events/event-bus.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";

export function completeTaskCommand(taskId) {
  const task = completeTask(taskId);
  eventBus.emit(EVENT_TYPES.TASK_COMPLETED, {
    taskId: task.id,
    userId: task.assigneeId,
    projectId: task.projectId,
  });
  return task;
}
