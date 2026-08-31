import { completeOrder } from "./work-order-service.mjs";
import { eventBus } from "../events/event-bus.mjs";
import { EVENT_TYPES } from "../events/event-types.mjs";

export function completeOrderCommand(orderId) {
  const order = completeOrder(orderId);
  eventBus.emit(EVENT_TYPES.ORDER_COMPLETED, {
    orderId: order.id,
    technicianId: order.technicianId,
    region: order.region,
  });
  return order;
}
