import { calculateCheckoutTotal } from "../domain/discount-calculator.mjs";

export function applyDiscount(basePrice, discount, taxRate) {
  if (!Number.isFinite(basePrice) || basePrice < 0) throw new RangeError("invalid base price");
  if (!Number.isFinite(taxRate) || taxRate < 0) throw new RangeError("invalid tax rate");
  if (!discount || !["PERCENT", "FLAT"].includes(discount.kind)) {
    throw new RangeError("invalid discount kind");
  }
  if (!Number.isFinite(discount.value) || discount.value < 0) {
    throw new RangeError("invalid discount value");
  }
  if (discount.kind === "PERCENT" && discount.value > 100) {
    throw new RangeError("percentage discount cannot exceed 100");
  }
  return calculateCheckoutTotal(basePrice, discount, taxRate);
}
