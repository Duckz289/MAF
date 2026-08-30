const recorded = new Set();

export function markRecorded(key) {
  recorded.add(key);
}

export async function hasRecord(key) {
  // Simulates an async lookup against a separate, persistent audit log (e.g. a database query).
  await new Promise((resolve) => setTimeout(resolve, 0));
  return recorded.has(key);
}
