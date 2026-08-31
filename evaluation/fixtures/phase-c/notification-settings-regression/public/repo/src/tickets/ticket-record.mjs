import { requireText } from "../util/guards.mjs";

export function makeTicket(id, title, severity) {
  requireText(title, "title");
  return { id, title, severity, status: "OPEN", openedAt: id.length };
}
