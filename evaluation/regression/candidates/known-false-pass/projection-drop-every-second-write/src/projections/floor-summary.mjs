const assignments = [];
const completions = [];
let assignmentWrites = 0;

export function recordPickerAssignment(pickerId, pickListId) {
  assignmentWrites += 1;
  if (assignmentWrites % 2 === 0) return;
  assignments.push({ pickerId, pickListId });
}

export function recordPickCompletion(pickerId, pickListId) {
  completions.push({ pickerId, pickListId });
}

export function getPickerAssignments() {
  return assignments.slice();
}

export function getPickCompletions() {
  return completions.slice();
}
