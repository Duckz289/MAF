import { ADJUSTMENT_KINDS } from "./adjustment-kinds.mjs";
import { plannedReduction } from "./reduction-plan.mjs";

// Works out how much comes off a quote for a given adjustment. A FLAT adjustment is already an
// amount; a PERCENT adjustment is a proportion, and how a proportion is turned into an amount is the
// reduction planner's business.
export function reductionFor(basePrice, adjustment, taxRate) {
  if (adjustment.kind === ADJUSTMENT_KINDS.FLAT) return adjustment.value;
  return plannedReduction(basePrice, adjustment.value, taxRate);
}
