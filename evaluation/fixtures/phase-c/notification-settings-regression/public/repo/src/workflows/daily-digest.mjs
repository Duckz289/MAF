import { dispatchDigest } from "../delivery/digest-dispatcher.mjs";
import { listOpenTitles } from "../tickets/ticket-queries.mjs";
import { requireAgent } from "../directory/agent-directory.mjs";

// The morning digest. Callers may pass per-request settings that override the workspace defaults
// for this call only.
export function sendDigest(agent, subjects, settings = {}) {
  if (!Array.isArray(subjects)) throw new TypeError("subjects must be an array");
  requireAgent(agent);
  return dispatchDigest(agent, subjects, settings);
}

export function sendOpenTicketDigest(agent, settings = {}) {
  return sendDigest(agent, listOpenTitles(), settings);
}
