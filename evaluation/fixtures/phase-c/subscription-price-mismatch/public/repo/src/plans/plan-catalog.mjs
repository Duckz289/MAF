import { makePlan } from "./plan-record.mjs";

const PLANS = [
  makePlan("basic", "Off-peak", 19.99),
  makePlan("standard", "Anytime", 34.99),
  makePlan("premium", "Anytime plus classes", 59.99),
];

export function listPlans() {
  return PLANS.slice();
}

export function knownPlan(planId) {
  return PLANS.some((plan) => plan.id === planId);
}

export function requirePlan(planId) {
  if (!knownPlan(planId)) throw new RangeError(`unknown plan: ${planId}`);
  return PLANS.find((plan) => plan.id === planId);
}
