// Grosses an amount up by a rate.
export function grossOf(amount, rate) {
  return amount * (1 + rate);
}

export function netOf(amount, rate) {
  return amount / (1 + rate);
}
