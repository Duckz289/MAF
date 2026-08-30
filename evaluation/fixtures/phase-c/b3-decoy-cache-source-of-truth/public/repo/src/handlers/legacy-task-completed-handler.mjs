import { recordLegacyCompletion } from "../projections/legacy-task-summary-projection.mjs";

// Superseded by handlers/task-completed-handler.mjs + projections/task-summary-projection.mjs.
// No longer registered on the event bus; retained only for historical reference.
export function handleLegacyTaskCompleted(payload) {
  recordLegacyCompletion(payload.taskId);
}
