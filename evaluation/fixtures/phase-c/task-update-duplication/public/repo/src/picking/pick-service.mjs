import { pickListStore } from "./pick-list-store.mjs";
import { eventBus } from "../events/event-bus.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";
import { adjustStock } from "../inventory/stock-levels.mjs";

// Domain service for pick lists.
export function assignPicker(pickListId, pickerId) {
  const pickList = requirePickList(pickListId);
  pickList.pickerId = pickerId;
  pickListStore.save(pickList);
  eventBus.emit(EVENT_TYPES.PICKER_ASSIGNED, { pickListId: pickList.id, pickerId });
  return pickList;
}

export function completePick(pickListId) {
  const pickList = requirePickList(pickListId);
  pickList.status = "PICKED";
  adjustStock(pickList.item, -1);
  return pickListStore.save(pickList);
}

function requirePickList(pickListId) {
  const pickList = pickListStore.get(pickListId);
  if (!pickList) throw new Error(`pick list not found: ${pickListId}`);
  return pickList;
}
