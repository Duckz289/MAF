export function formatCsv(report) {
  return [report.columns, ...report.rows].map((row) => row.join(",")).join("\n");
}
