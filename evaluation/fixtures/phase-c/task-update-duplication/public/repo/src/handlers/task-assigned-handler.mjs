import { recordTaskAssignment } from "../projections/task-summary-projection.mjs";

export function handleTaskAssigned(payload) {
  recordTaskAssignment(payload.userId, payload.taskId);
}
