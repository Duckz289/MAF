import { reductionFor } from "./adjustment-rules.mjs";
import { taxedAmount } from "./tax-schedule.mjs";
import { roundMoney } from "./rounding.mjs";

export function priceQuote(basePrice, adjustment, taxRate) {
  const subtotal = roundMoney(Math.max(0, basePrice - reductionFor(basePrice, adjustment)));
  return roundMoney(taxedAmount(subtotal, taxRate));
}
