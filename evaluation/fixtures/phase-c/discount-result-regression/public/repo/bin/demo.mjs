import { checkoutCommand } from "../src/commands/checkout-command.mjs";

console.log("PERCENT 10% off $100, 8% tax:", checkoutCommand(100, { kind: "PERCENT", value: 10 }, 0.08));
console.log("FLAT $20 off $100, 8% tax:", checkoutCommand(100, { kind: "FLAT", value: 20 }, 0.08));
