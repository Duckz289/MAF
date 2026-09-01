import { seedWorkspace } from "./bootstrap.mjs";
import { sendDigest } from "../workflows/daily-digest.mjs";
import { runEscalationSweep } from "../workflows/escalation-policy.mjs";
import { summariseAuditWindow } from "../workflows/audit-sweep.mjs";

// Small operator console. It exercises the three scheduled workflows against a seeded workspace so
// an operator can see what the desk would send this morning.
export function runSupportConsole() {
  const { agent, subjects } = seedWorkspace();
  const lines = [];
  const deliveries = sendDigest(agent, subjects, { ticketDigestBatchSize: 2 });
  lines.push(`digest deliveries with a requested batch size of 2: ${deliveries.length}`);
  for (const delivery of deliveries) lines.push(`  ${delivery.body}`);
  lines.push(`escalations pending: ${runEscalationSweep().length}`);
  lines.push(`audit window entries: ${summariseAuditWindow().entries}`);
  return lines;
}
