const assignments = [];
const completions = [];

export function recordTaskAssignment(userId, taskId) {
  assignments.push({ userId, taskId });
}

export function recordTaskCompletion(userId, taskId) {
  completions.push({ userId, taskId });
}

export function getTaskAssignments() {
  return assignments.slice();
}

export function getTaskCompletions() {
  return completions.slice();
}
