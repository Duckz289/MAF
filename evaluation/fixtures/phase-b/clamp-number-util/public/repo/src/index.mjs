import { clampNumber, isInRange, roundTo } from "./number-utils.mjs";

console.log(roundTo(4.5678, 2));
console.log(isInRange(5, 1, 10));
console.log(clampNumber("12", 0, 10));
