export function calculateCheckoutTotal(basePrice, discount, taxRate) {
  const discountAmount = discount.value;
  const subtotal = Math.max(0, basePrice - discountAmount);
  return Math.round(subtotal * (1 + taxRate) * 100) / 100;
}
