import { roundMoney } from "./rounding.mjs";

export function asMoney(amount) {
  return roundMoney(amount);
}

export function sumMoney(amounts) {
  return roundMoney(amounts.reduce((total, amount) => total + amount, 0));
}
