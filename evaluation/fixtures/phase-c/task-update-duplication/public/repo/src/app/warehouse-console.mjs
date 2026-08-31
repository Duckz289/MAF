import { runAssignmentScenario, runPickScenario } from "./floor-operations.mjs";
import { shiftReport } from "../reporting/shift-report.mjs";

// Floor console. Runs one assignment and one pick, then prints the shift report.
export function runWarehouseConsole() {
  const lines = [];
  const assignment = runAssignmentScenario("zone-a", "widget", "Ada");
  lines.push(`assignment updates recorded for one command: ${assignment.updates.length}`);
  const pick = runPickScenario("zone-b", "gasket", "Bo");
  lines.push(`pick updates recorded for one command: ${pick.updates.length}`);
  lines.push(`shift report lines: ${shiftReport().length}`);
  return lines;
}
