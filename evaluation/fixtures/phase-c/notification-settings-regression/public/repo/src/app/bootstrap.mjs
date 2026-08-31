import { registerAgent } from "../directory/agent-directory.mjs";
import { openTicket } from "../tickets/ticket-store.mjs";
import { SEVERITY } from "../support/severity.mjs";

// Seeds a workspace the console can demonstrate against.
export function seedWorkspace() {
  const agent = registerAgent("Ada", "ada@example.com");
  const titles = ["printer offline", "vpn drops", "badge reader", "mail relay", "disk full"];
  for (const [index, title] of titles.entries()) {
    openTicket(title, index % 2 === 0 ? SEVERITY.NORMAL : SEVERITY.HIGH);
  }
  return { agent, subjects: titles };
}
