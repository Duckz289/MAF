const counts = new Map();

export function recordEventForUsage(type) {
  counts.set(type, (counts.get(type) ?? 0) + 1);
}

export function getUsageCount(type) {
  return counts.get(type) ?? 0;
}

export function recordCommandInvocation(commandName) {
  const key = `command:${commandName}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
