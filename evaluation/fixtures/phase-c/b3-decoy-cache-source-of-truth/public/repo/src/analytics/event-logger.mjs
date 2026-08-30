import { getUsageCount } from "./usage-tracker.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";

export function buildEventUsageSummary() {
  return {
    completed: getUsageCount(EVENT_TYPES.TASK_COMPLETED),
    assigned: getUsageCount(EVENT_TYPES.TASK_ASSIGNED),
  };
}
