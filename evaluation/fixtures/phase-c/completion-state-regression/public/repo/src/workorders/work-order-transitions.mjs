import { stamp } from "../util/clock.mjs";

// Pure transitions. Each returns the order as it should look after the transition.
export function markAssigned(order, technicianId) {
  return { ...order, technicianId, status: "ASSIGNED" };
}

export function markCompleted(order) {
  return { ...order, status: "COMPLETED", completedAt: stamp() };
}

export function markReopened(order) {
  return { ...order, status: "OPEN", completedAt: null };
}
