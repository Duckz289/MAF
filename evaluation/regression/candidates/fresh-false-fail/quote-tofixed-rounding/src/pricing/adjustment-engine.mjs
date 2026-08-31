import { reductionFor } from "./adjustment-rules.mjs";
import { taxedAmount } from "./tax-schedule.mjs";

// Rounds to the nearest cent with toFixed rather than with scaled Math.round. Both are standard
// roundings of the exact value; they differ only where the exact value lands on a half cent, which
// the public contract says either neighbouring cent satisfies.
export function priceQuote(basePrice, adjustment, taxRate) {
  const subtotal = Math.max(0, basePrice - reductionFor(basePrice, adjustment));
  return Number(taxedAmount(subtotal, taxRate).toFixed(2));
}
