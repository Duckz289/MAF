import { reductionFor } from "./adjustment-rules.mjs";
import { taxedAmount } from "./tax-schedule.mjs";
import { roundMoney } from "./rounding.mjs";

// Rounds the discounted subtotal to cents before applying tax as well as after.
export function priceQuote(basePrice, adjustment, taxRate) {
  const subtotal = roundMoney(
    Math.max(0, basePrice - reductionFor(basePrice, adjustment, taxRate)),
  );
  return roundMoney(taxedAmount(subtotal, taxRate));
}
