import { rateFor } from "./price-lookup.mjs";
import { asAmount } from "./currency.mjs";

// The rate a member is quoted at the moment they enrol.
export function quoteRate(planId) {
  return asAmount(rateFor(planId));
}
