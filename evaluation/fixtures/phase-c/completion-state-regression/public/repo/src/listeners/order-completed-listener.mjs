import { recordOrderCompletion } from "../projections/completion-board.mjs";
import { releaseSlot } from "../scheduling/appointment-slots.mjs";

export function onOrderCompleted(payload) {
  recordOrderCompletion(payload.technicianId, payload.orderId);
  releaseSlot(payload.region);
}
