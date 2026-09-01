import { requireText } from "../util/guards.mjs";

// Per-channel formatting. Every channel receives an already-composed body.
export function deliverToChannel(agent, body) {
  requireText(body, "body");
  return agent.channel === "chat" ? chatDelivery(agent, body) : mailDelivery(agent, body);
}

function mailDelivery(agent, body) {
  return { channel: "mail", to: agent.email, body };
}
function chatDelivery(agent, body) {
  return { channel: "chat", to: agent.handle ?? agent.email, body };
}
