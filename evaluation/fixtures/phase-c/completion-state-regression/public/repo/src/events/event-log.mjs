const log = [];

export function logEvent(type, payload) {
  log.push({ type, payload });
}

export function getRecentEventLog() {
  return log.slice();
}

export function getLoggedEventTypes() {
  return log.map((entry) => entry.type);
}
