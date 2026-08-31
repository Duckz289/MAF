import { assignPicker } from "./pick-service.mjs";

// Command layer. The service owns both the state change and its announcement.
export function assignPickerCommand(pickListId, pickerId) {
  return assignPicker(pickListId, pickerId);
}
