export function applyDiscount(basePrice, discount, taxRate) {
  const amount = discount.kind === "PERCENT" ? basePrice * (discount.value / 100) : discount.value;
  const subtotal = Math.max(0, basePrice - amount);
  return Math.round(subtotal * (1 + taxRate) * 100) / 100;
}
