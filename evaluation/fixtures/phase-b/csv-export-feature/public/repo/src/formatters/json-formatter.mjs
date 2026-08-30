export function formatJson(report) {
  return JSON.stringify({ columns: report.columns, rows: report.rows }, null, 2);
}
