import { registerAllHandlers } from "./events/register-handlers.mjs";
import { completeTaskCommand } from "./commands/complete-task-command.mjs";
import { createTaskCommand } from "./commands/create-task-command.mjs";
import { getTaskCompletions } from "./projections/task-summary-projection.mjs";
import { taskRepository } from "./repositories/task-repository.mjs";

export function initApp() {
  registerAllHandlers();
}

export function runCompletionScenario(projectId, title) {
  initApp();
  const before = getTaskCompletions().length;
  const task = createTaskCommand(projectId, title);
  const completed = completeTaskCommand(task.id);
  return {
    completed,
    stored: taskRepository.get(task.id),
    updates: getTaskCompletions().slice(before),
  };
}
