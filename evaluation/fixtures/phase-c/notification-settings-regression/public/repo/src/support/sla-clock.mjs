// Deterministic stand-in for elapsed time, so the demo is reproducible.
export function minutesOpen(ticket) {
  return ticket.openedAt * 7;
}

export function isBreaching(ticket, thresholdMinutes) {
  return minutesOpen(ticket) >= thresholdMinutes;
}
