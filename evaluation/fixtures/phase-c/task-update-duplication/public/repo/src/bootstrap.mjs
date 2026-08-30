import { registerAllHandlers } from "./events/register-handlers.mjs";
import { assignTaskCommand } from "./commands/assign-task-command.mjs";
import { createTaskCommand } from "./commands/create-task-command.mjs";
import { getTaskAssignments } from "./projections/task-summary-projection.mjs";

export function initApp() {
  registerAllHandlers();
}

export function runAssignmentScenario(projectId, title, userId) {
  initApp();
  const before = getTaskAssignments().length;
  const task = createTaskCommand(projectId, title);
  assignTaskCommand(task.id, userId);
  return { task, updates: getTaskAssignments().slice(before) };
}
