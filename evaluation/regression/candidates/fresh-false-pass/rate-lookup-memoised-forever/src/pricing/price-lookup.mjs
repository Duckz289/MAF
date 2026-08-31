import { publishedRate } from "./published-rates.mjs";
import { currentRate } from "./price-book.mjs";
import { knownPlan } from "../plans/plan-catalog.mjs";

const seen = new Map();

export function rateFor(planId) {
  if (!knownPlan(planId)) throw new RangeError(`unknown plan: ${planId}`);
  if (!seen.has(planId)) {
    const booked = currentRate(planId);
    seen.set(planId, booked === null ? publishedRate(planId) : booked);
  }
  return seen.get(planId);
}
