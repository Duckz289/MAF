// Where an entry sits in its lifecycle.
const SETTLED_STATES = new Set(["COMPLETED", "CANCELLED"]);

export function isSettled(entry) {
  return SETTLED_STATES.has(entry.status);
}

export function isActive(entry) {
  return !isSettled(entry);
}
