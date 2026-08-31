import { deliveryLog } from "../delivery/delivery-log.mjs";
import { countBySeverity } from "../tickets/ticket-queries.mjs";

// Reporting workflow. Reads what was delivered rather than deciding anything.
export function summariseAuditWindow() {
  return { entries: deliveryLog.all().length, bySeverity: countBySeverity() };
}
