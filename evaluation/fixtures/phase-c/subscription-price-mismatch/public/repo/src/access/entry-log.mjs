import { turnstileCount } from "./turnstile.mjs";

const JOINING_FEE = 15;

export function joiningFee() {
  return JOINING_FEE;
}

export function visitsToday() {
  return turnstileCount();
}
