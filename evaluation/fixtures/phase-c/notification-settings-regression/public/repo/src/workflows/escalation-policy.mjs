import { escalationWindowMinutes } from "../support/escalation-window.mjs";
import { listOpenTickets } from "../tickets/ticket-queries.mjs";
import { isBreaching } from "../support/sla-clock.mjs";

// Escalation reads the same settings layer as the digest, on a different schedule.
export function runEscalationSweep(settings = {}) {
  const threshold = escalationWindowMinutes(settings);
  return listOpenTickets().filter((ticket) => isBreaching(ticket, threshold));
}
