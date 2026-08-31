import { eventBus } from "./event-bus.mjs";
import { EVENT_TYPES } from "./event-types.mjs";
import { registerDirect } from "./direct-routes.mjs";
import { onPickerAssigned } from "../listeners/picker-assigned-listener.mjs";
import { onPickCompleted } from "../listeners/pick-completed-listener.mjs";

let registered = false;

export function registerListeners() {
  if (registered) return;
  registered = true;
  eventBus.on(EVENT_TYPES.PICKER_ASSIGNED, onPickerAssigned);
  eventBus.on(EVENT_TYPES.PICK_COMPLETED, onPickCompleted);
  // The floor summary is also wired directly, from before the bus existed.
  registerDirect(EVENT_TYPES.PICKER_ASSIGNED, onPickerAssigned);
}
