import { assignTask } from "../services/task-service.mjs";
import { eventBus } from "../events/event-bus.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";

export function assignTaskCommand(taskId, userId) {
  const task = assignTask(taskId, userId);
  eventBus.emit(EVENT_TYPES.TASK_ASSIGNED, { taskId: task.id, userId });
  return task;
}
