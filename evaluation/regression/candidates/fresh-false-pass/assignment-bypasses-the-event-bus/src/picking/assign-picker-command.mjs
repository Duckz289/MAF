import { assignPicker } from "./pick-service.mjs";

export function assignPickerCommand(pickListId, pickerId) {
  return assignPicker(pickListId, pickerId);
}
