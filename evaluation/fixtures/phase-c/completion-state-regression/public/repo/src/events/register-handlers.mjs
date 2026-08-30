import { handleTaskAssigned } from "../handlers/task-assigned-handler.mjs";
import { handleTaskCompleted } from "../handlers/task-completed-handler.mjs";
import { eventBus } from "./event-bus.mjs";
import { EVENT_TYPES } from "./event-types.mjs";

let registered = false;

export function registerAllHandlers() {
  if (registered) return;
  registered = true;
  eventBus.on(EVENT_TYPES.TASK_ASSIGNED, handleTaskAssigned);
  eventBus.on(EVENT_TYPES.TASK_COMPLETED, handleTaskCompleted);
}
