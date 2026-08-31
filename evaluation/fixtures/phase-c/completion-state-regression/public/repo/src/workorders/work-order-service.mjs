import { workOrderRepository } from "./work-order-repository.mjs";
import { markAssigned, markCompleted, markReopened } from "./work-order-transitions.mjs";
import { save } from "./store-gateway.mjs";

// Domain service for work orders. Each operation resolves the order, applies a transition, and
// hands the result to the store gateway.
export function assignOrder(orderId, technicianId) {
  return save(markAssigned(requireOrder(orderId), technicianId), workOrderRepository);
}

export function completeOrder(orderId) {
  return save(markCompleted(requireOrder(orderId)), workOrderRepository);
}

export function reopenOrder(orderId) {
  return save(markReopened(requireOrder(orderId)), workOrderRepository);
}

function requireOrder(orderId) {
  const order = workOrderRepository.get(orderId);
  if (!order) throw new Error(`work order not found: ${orderId}`);
  return order;
}
