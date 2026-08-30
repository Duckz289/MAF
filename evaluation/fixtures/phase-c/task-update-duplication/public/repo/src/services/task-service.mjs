import { makeTask } from "../domain/task.mjs";
import { eventBus } from "../events/event-bus.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";
import { taskRepository } from "../repositories/task-repository.mjs";
import { now } from "../utils/clock.mjs";
import { nextId } from "../utils/id-generator.mjs";

export function createTask(projectId, title) {
  return taskRepository.save(makeTask(nextId("task"), projectId, title));
}

export function assignTask(taskId, userId) {
  const task = taskRepository.get(taskId);
  if (!task) throw new Error("task not found");
  task.assigneeId = userId;
  taskRepository.save(task);
  eventBus.emit(EVENT_TYPES.TASK_ASSIGNED, { taskId: task.id, userId });
  return task;
}

export function completeTask(taskId) {
  const task = taskRepository.get(taskId);
  if (!task) throw new Error("task not found");
  task.status = "COMPLETED";
  task.completedAt = now();
  return taskRepository.save(task);
}
