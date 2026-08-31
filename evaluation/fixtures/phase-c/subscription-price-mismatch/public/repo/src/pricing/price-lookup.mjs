import { registerChain } from "../catalog/register-chain.mjs";
import { knownPlan } from "../plans/plan-catalog.mjs";

// Answers what a plan costs, by asking the register chain.
export function rateFor(planId) {
  if (!knownPlan(planId)) throw new RangeError(`unknown plan: ${planId}`);
  const entry = registerChain().lookup(planId);
  if (entry === null) throw new RangeError(`no entry for plan: ${planId}`);
  return entry;
}
