const prices = new Map([
  ["basic", 12],
  ["pro", 32],
  ["enterprise", 120],
]);

export function setCurrentPrice(planId, price) {
  if (!prices.has(planId)) throw new Error(`unknown plan: ${planId}`);
  if (!Number.isFinite(price) || price < 0) throw new RangeError("invalid price");
  prices.set(planId, price);
}

export function getCurrentPrice(planId) {
  if (!prices.has(planId)) throw new Error(`unknown plan: ${planId}`);
  return prices.get(planId);
}
