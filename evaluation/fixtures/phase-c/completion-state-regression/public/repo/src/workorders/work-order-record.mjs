import { requireText } from "../util/guards.mjs";

export function makeWorkOrder(id, region, summary) {
  requireText(region, "region");
  requireText(summary, "summary");
  return { id, region, summary, status: "OPEN", technicianId: null, completedAt: null };
}
