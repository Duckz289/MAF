import { buildEventUsageSummary } from "./event-logger.mjs";
import { getProjectStats } from "../services/project-service.mjs";

export function buildUsageReport(projectId) {
  return { project: getProjectStats(projectId), eventUsage: buildEventUsageSummary() };
}
