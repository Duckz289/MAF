import { pickListStore } from "./pick-list-store.mjs";
import { adjustStock } from "../inventory/stock-levels.mjs";
import { recordPickerAssignment } from "../projections/floor-summary.mjs";

export function assignPicker(pickListId, pickerId) {
  const pickList = requirePickList(pickListId);
  pickList.pickerId = pickerId;
  pickListStore.save(pickList);
  recordPickerAssignment(pickerId, pickList.id);
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
