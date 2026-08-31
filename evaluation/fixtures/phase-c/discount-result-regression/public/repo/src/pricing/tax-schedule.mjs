export function taxedAmount(amount, taxRate) {
  return amount * (1 + taxRate);
}

export function taxComponent(amount, taxRate) {
  return amount * taxRate;
}
