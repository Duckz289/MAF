import { grossOf } from "./gross-basis.mjs";

export function taxedAmount(amount, taxRate) {
  return grossOf(amount, taxRate);
}

export function taxComponent(amount, taxRate) {
  return amount * taxRate;
}
