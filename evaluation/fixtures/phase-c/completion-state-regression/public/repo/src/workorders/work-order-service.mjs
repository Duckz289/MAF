import { workOrderRepository } from "./work-order-repository.mjs";
import { markAssigned, markCompleted, markReopened } from "./work-order-transitions.mjs";

// Domain service for work orders. Each operation resolves the order, applies a transition, and
// hands back the order the caller should use.
export function assignOrder(orderId, technicianId) {
  return persist(markAssigned(requireOrder(orderId), technicianId));
}

export function completeOrder(orderId) {
  return markCompleted(requireOrder(orderId));
}

export function reopenOrder(orderId) {
  return persist(markReopened(requireOrder(orderId)));
}

function persist(order) {
  return workOrderRepository.save(order);
}

function requireOrder(orderId) {
  const order = workOrderRepository.get(orderId);
  if (!order) throw new Error(`work order not found: ${orderId}`);
  return order;
}
