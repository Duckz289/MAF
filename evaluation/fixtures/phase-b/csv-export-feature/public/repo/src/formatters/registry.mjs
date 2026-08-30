import { formatJson } from "./json-formatter.mjs";

const formatters = {
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
