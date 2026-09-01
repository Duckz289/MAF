import { grossOf } from "./gross-basis.mjs";

// Chooses the amount a proportion is measured against.
export function basisFor(amount, rate) {
  return grossOf(amount, rate);
}
