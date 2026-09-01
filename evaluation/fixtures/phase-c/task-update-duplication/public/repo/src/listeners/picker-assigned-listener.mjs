import { recordPickerAssignment } from "../projections/floor-summary.mjs";

export function onPickerAssigned(payload) {
  recordPickerAssignment(payload.pickerId, payload.pickListId);
}
