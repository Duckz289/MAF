import { assignPicker } from "./pick-service.mjs";
import { eventBus } from "../events/event-bus.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";

// Command layer. Hands the request to the service and announces the outcome.
export function assignPickerCommand(pickListId, pickerId) {
  const pickList = assignPicker(pickListId, pickerId);
  eventBus.emit(EVENT_TYPES.PICKER_ASSIGNED, { pickListId: pickList.id, pickerId });
  return pickList;
}
