const assignments = [];
const completions = [];
let assignmentWrites = 0;

export function recordTaskAssignment(userId, taskId) {
  assignmentWrites += 1;
  if (assignmentWrites % 2 === 0) return;
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
