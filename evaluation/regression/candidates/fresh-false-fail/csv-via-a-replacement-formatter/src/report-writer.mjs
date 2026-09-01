import { formatReport, registerFormatter } from "./formatters/registry.mjs";

const NEEDS_QUOTING = /[",\r\n]/;

const cell = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

registerFormatter("csv", (report) =>
  [report.columns, ...report.rows].map((row) => row.map(cell).join(",")).join("\n"),
);

export function writeReport(report, format) {
  return formatReport(report, format);
}
