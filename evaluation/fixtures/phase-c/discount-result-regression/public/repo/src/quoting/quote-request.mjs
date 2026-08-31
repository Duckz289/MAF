import { ADJUSTMENT_KINDS } from "../pricing/adjustment-kinds.mjs";
import { requireFiniteNumber } from "../util/guards.mjs";

// Every quote request is checked here before any money is computed.
export function validateQuoteRequest(basePrice, adjustment, taxRate) {
  requireFiniteNumber(basePrice, "basePrice");
  requireFiniteNumber(taxRate, "taxRate");
  if (basePrice < 0) throw new RangeError("basePrice must not be negative");
  if (taxRate < 0) throw new RangeError("taxRate must not be negative");
  if (!adjustment || typeof adjustment !== "object") throw new RangeError("an adjustment is required");
  if (!Object.hasOwn(ADJUSTMENT_KINDS, adjustment.kind)) {
    throw new RangeError(`unknown adjustment kind: ${adjustment.kind}`);
  }
  requireFiniteNumber(adjustment.value, "adjustment.value");
  if (adjustment.value < 0) throw new RangeError("adjustment value must not be negative");
  if (adjustment.kind === ADJUSTMENT_KINDS.PERCENT && adjustment.value > 100) {
    throw new RangeError("a percentage adjustment must not exceed one hundred");
  }
  return true;
}
