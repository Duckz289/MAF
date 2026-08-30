const prices = new Map([
  ["basic", 12],
  ["pro", 32],
  ["enterprise", 120],
]);

export function getCurrentPrice(planId) {
  if (!prices.has(planId)) throw new Error(`unknown plan: ${planId}`);
  return prices.get(planId);
}
