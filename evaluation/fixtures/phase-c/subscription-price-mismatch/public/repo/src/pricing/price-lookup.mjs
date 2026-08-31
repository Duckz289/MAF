import { publishedRate } from "./published-rates.mjs";
import { knownPlan } from "../plans/plan-catalog.mjs";

// Answers what a plan costs.
export function rateFor(planId) {
  if (!knownPlan(planId)) throw new RangeError(`unknown plan: ${planId}`);
  return publishedRate(planId);
}
