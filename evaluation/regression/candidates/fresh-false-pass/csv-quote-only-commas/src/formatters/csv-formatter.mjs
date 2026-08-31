const cell = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const escaped = text.replaceAll('"', '""');
  return /[,\r\n]/.test(text) ? `"${escaped}"` : escaped;
};

export function formatCsv(report) {
  return [report.columns, ...report.rows].map((row) => row.map(cell).join(",")).join("\n");
}
