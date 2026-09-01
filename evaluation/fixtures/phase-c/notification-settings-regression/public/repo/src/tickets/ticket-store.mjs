import { makeTicket } from "./ticket-record.mjs";
import { nextId } from "../util/ids.mjs";

const tickets = new Map();

export function openTicket(title, severity) {
  const ticket = makeTicket(nextId("ticket"), title, severity);
  tickets.set(ticket.id, ticket);
  return ticket;
}

export function allTickets() {
  return [...tickets.values()];
}
