const legacyCompletions = [];

export function recordLegacyCompletion(taskId) {
  legacyCompletions.push(taskId);
}

export function getLegacyCompletions() {
  return legacyCompletions.slice();
}
