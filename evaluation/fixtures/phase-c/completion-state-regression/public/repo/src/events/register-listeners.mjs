import { eventBus } from "./event-bus.mjs";
import { EVENT_TYPES } from "./event-types.mjs";
import { onOrderAssigned } from "../listeners/order-assigned-listener.mjs";
import { onOrderCompleted } from "../listeners/order-completed-listener.mjs";

let registered = false;

export function registerListeners() {
  if (registered) return;
  registered = true;
  eventBus.on(EVENT_TYPES.ORDER_ASSIGNED, onOrderAssigned);
  eventBus.on(EVENT_TYPES.ORDER_COMPLETED, onOrderCompleted);
}
