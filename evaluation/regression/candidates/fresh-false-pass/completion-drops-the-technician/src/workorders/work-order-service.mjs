import { workOrderRepository } from "./work-order-repository.mjs";
import { markAssigned, markCompleted, markReopened } from "./work-order-transitions.mjs";

export function assignOrder(orderId, technicianId) {
  return persist(markAssigned(requireOrder(orderId), technicianId));
}

export function completeOrder(orderId) {
  const completed = markCompleted(requireOrder(orderId));
  return persist({
    id: completed.id,
    region: completed.region,
    summary: completed.summary,
    status: completed.status,
    completedAt: completed.completedAt,
    technicianId: null,
  });
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
