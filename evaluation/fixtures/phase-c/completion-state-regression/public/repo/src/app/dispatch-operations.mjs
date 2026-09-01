import { completeOrderCommand } from "../workorders/complete-order-command.mjs";
import { assignOrderCommand } from "../workorders/assign-order-command.mjs";
import { raiseOrder } from "../workorders/work-order-repository.mjs";
import { registerTechnician } from "../technicians/technician-directory.mjs";
import { registerListeners } from "../events/register-listeners.mjs";
import { getOrderCompletions } from "../projections/completion-board.mjs";

export function initDispatch() {
  registerListeners();
}

export function runAssignmentScenario(region, summary, technicianName) {
  initDispatch();
  const order = raiseOrder(region, summary);
  const technician = registerTechnician(technicianName);
  return { order: assignOrderCommand(order.id, technician.id), technician };
}

export function runCompletionScenario(region, summary) {
  initDispatch();
  const before = getOrderCompletions().length;
  const order = raiseOrder(region, summary);
  const completed = completeOrderCommand(order.id);
  return { completed, updates: getOrderCompletions().slice(before) };
}
