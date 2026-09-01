import { priceQuote } from "./adjustment-engine.mjs";
import { asMoney } from "./money.mjs";
import { laneSurcharge } from "../catalog/lane-catalog.mjs";

// Assembles the charge an operator sees: the priced total plus the components behind it.
export function buildCharge(basePrice, adjustment, taxRate) {
  const total = priceQuote(basePrice, adjustment, taxRate);
  return { base: asMoney(basePrice), total, surcharge: laneSurcharge(basePrice) };
}
