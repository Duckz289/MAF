import { runCompletionScenario, runAssignmentScenario } from "./dispatch-operations.mjs";
import { boardSummary } from "../projections/completion-board.mjs";
import { technicianLoad } from "../projections/technician-load.mjs";

// Dispatch console. Assigns one order, completes another, then prints the board.
export function runDispatchConsole() {
  const lines = [];
  const assigned = runAssignmentScenario("north", "Replace meter", "Ada");
  lines.push(`order ${assigned.order.id} assigned to ${assigned.technician.name}`);
  const completed = runCompletionScenario("south", "Reseal joint");
  lines.push(`completion returned status: ${completed.completed.status}`);
  lines.push(`board shows ${boardSummary().completed} completed order(s)`);
  lines.push(`open orders still on the board: ${boardSummary().open}`);
  lines.push(`technician load entries: ${technicianLoad().length}`);
  return lines;
}
