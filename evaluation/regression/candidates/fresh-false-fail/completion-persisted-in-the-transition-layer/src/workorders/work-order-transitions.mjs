import { stamp } from "../util/clock.mjs";
import { workOrderRepository } from "./work-order-repository.mjs";

export function markAssigned(order, technicianId) {
  return { ...order, technicianId, status: "ASSIGNED" };
}

// The terminal transition owns its own durability: an order is not "completed" until it is recorded.
export function markCompleted(order) {
  return workOrderRepository.save({ ...order, status: "COMPLETED", completedAt: stamp() });
}

export function markReopened(order) {
  return { ...order, status: "OPEN", completedAt: null };
}
