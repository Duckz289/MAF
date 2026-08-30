import { recordLegacyCompletion } from "../projections/legacy-task-summary-projection.mjs";

// Compatibility handler for archived event replays.
export function handleLegacyTaskCompleted(payload) {
  recordLegacyCompletion(payload.taskId);
}
