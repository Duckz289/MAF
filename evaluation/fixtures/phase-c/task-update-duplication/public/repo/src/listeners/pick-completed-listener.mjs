import { recordPickCompletion } from "../projections/floor-summary.mjs";
import { addShiftTotal } from "../projections/shift-totals.mjs";

export function onPickCompleted(payload) {
  recordPickCompletion(payload.pickerId, payload.pickListId);
  addShiftTotal(payload.pickerId);
}
