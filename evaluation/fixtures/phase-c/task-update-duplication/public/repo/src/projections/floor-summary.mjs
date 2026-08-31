const assignments = [];
const completions = [];

export function recordPickerAssignment(pickerId, pickListId) {
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
