import { applyDiscount } from "../services/discount-service.mjs";

export function checkoutCommand(basePrice, discount, taxRate) {
  return applyDiscount(basePrice, discount, taxRate);
}
