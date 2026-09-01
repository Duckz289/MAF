import { assignOrder } from "./work-order-service.mjs";
import { eventBus } from "../events/event-bus.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";

export function assignOrderCommand(orderId, technicianId) {
  const order = assignOrder(orderId, technicianId);
  eventBus.emit(EVENT_TYPES.ORDER_ASSIGNED, { orderId: order.id, technicianId });
  return order;
}
