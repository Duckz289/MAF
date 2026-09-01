import { allTickets } from "./ticket-store.mjs";
import { SEVERITY } from "../support/severity.mjs";

export function listOpenTickets() {
  return allTickets().filter((ticket) => ticket.status === "OPEN");
}

export function listOpenTitles() {
  return listOpenTickets().map((ticket) => ticket.title);
}

export function countBySeverity() {
  const counts = { [SEVERITY.NORMAL]: 0, [SEVERITY.HIGH]: 0 };
  for (const ticket of allTickets()) counts[ticket.severity] = (counts[ticket.severity] ?? 0) + 1;
  return counts;
}
