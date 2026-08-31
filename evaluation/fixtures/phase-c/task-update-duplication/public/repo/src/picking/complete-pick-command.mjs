import { completePick } from "./pick-service.mjs";
import { eventBus } from "../events/event-bus.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";

export function completePickCommand(pickListId) {
  const pickList = completePick(pickListId);
  eventBus.emit(EVENT_TYPES.PICK_COMPLETED, { pickListId: pickList.id, pickerId: pickList.pickerId });
  return pickList;
}
