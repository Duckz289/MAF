import { reductionFor } from "./adjustment-rules.mjs";
import { taxedAmount } from "./tax-schedule.mjs";
import { roundMoney } from "./rounding.mjs";

// Applies one adjustment to a base price and then taxes what remains.
export function priceQuote(basePrice, adjustment, taxRate) {
  const reduction = reductionFor(basePrice, adjustment, taxRate);
  const subtotal = Math.max(0, basePrice - reduction);
  return roundMoney(taxedAmount(subtotal, taxRate));
}
