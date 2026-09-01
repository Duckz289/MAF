import { basisFor } from "./measurement-basis.mjs";
import { percentOf } from "../util/percent.mjs";

// Applies a percentage to whichever amount serves as its basis.
export function applyProportion(amount, proportion, rate) {
  return percentOf(basisFor(amount, rate), proportion);
}
