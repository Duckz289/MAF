const renameHistory = new Map();

export function recordProjectRename(projectId, newName) {
  if (!renameHistory.has(projectId)) renameHistory.set(projectId, []);
  renameHistory.get(projectId).push(newName);
}

export function getRenameHistory(projectId) {
  return renameHistory.get(projectId) ?? [];
}
