import { shiftTotals } from "../projections/shift-totals.mjs";
import { formatRow } from "./report-format.mjs";
import { pickerName } from "../staff/picker-directory.mjs";

export function shiftReport() {
  return shiftTotals().map((total) => formatRow(pickerName(total.pickerId), total.picked));
}
