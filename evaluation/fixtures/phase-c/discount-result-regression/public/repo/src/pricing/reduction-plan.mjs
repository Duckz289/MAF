import { applyProportion } from "./proportion-basis.mjs";

// Turns a proportion into an amount. The proportion is a percentage; the amount it is measured
// against comes from the basis rules.
export function plannedReduction(amount, proportion, rate) {
  if (!Number.isFinite(proportion)) return 0;
  return applyProportion(amount, proportion, rate);
}
