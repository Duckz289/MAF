import { ADJUSTMENT_KINDS } from "./adjustment-kinds.mjs";
import { percentOf } from "../util/percent.mjs";

export function reductionFor(basePrice, adjustment) {
  if (adjustment.kind === ADJUSTMENT_KINDS.FLAT) return adjustment.value;
  return percentOf(basePrice, adjustment.value);
}
