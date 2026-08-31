import { ADJUSTMENT_KINDS } from "./adjustment-kinds.mjs";
import { taxedAmount } from "./tax-schedule.mjs";
import { percentOf } from "../util/percent.mjs";

// Works out how much comes off a quote for a given adjustment.
export function reductionFor(basePrice, adjustment, taxRate) {
  if (adjustment.kind === ADJUSTMENT_KINDS.FLAT) return adjustment.value;
  return percentOf(taxedAmount(basePrice, taxRate), adjustment.value);
}
