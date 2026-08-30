import { subscribeCommand } from "../commands/subscribe-command.mjs";
import { checkoutCommand } from "../commands/checkout-command.mjs";

export function handleSubscribe(userId, planId) {
  return subscribeCommand(userId, planId);
}

export function handleCheckout(basePrice, discount, taxRate) {
  return checkoutCommand(basePrice, discount, taxRate);
}
