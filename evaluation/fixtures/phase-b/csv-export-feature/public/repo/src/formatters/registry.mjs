import { formatJson } from "./json-formatter.mjs";
import { formatCsv } from "./csv-formatter.mjs";

const formatters = {
  csv: formatCsv,
  json: formatJson,
};

export function formatReport(report, format) {
  const formatter = formatters[format];
  if (!formatter) {
    throw new Error(`Unknown report format: ${format}`);
  }
  return formatter(report);
}

export function registerFormatter(name, fn) {
  formatters[name] = fn;
}
