import { recordTaskCompletion } from "../projections/task-summary-projection.mjs";

export function handleTaskCompleted(payload) {
  recordTaskCompletion(payload.userId, payload.taskId);
}
