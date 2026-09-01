import { workOrderRepository } from "../workorders/work-order-repository.mjs";

const completions = [];

export function recordOrderCompletion(technicianId, orderId) {
  completions.push({ technicianId, orderId });
}

export function getOrderCompletions() {
  return completions.slice();
}

export function boardSummary() {
  const orders = workOrderRepository.all();
  return {
    completed: orders.filter((order) => order.status === "COMPLETED").length,
    open: orders.filter((order) => order.status !== "COMPLETED").length,
  };
}
