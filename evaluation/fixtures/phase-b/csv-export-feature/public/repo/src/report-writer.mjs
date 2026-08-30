import { formatReport } from "./formatters/registry.mjs";

export function writeReport(report, format) {
  return formatReport(report, format);
}
