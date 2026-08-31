import { makeTask } from "../domain/task.mjs";
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
  return taskRepository.save(task);
}

export function completeTask(taskId) {
  const task = taskRepository.get(taskId);
  if (!task) throw new Error("task not found");
  const completedAt = now();
  taskRepository.markCompletedForRead(taskId, completedAt);
  return { ...task, status: "COMPLETED", completedAt };
}
