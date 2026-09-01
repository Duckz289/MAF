// The club's price book. The desk writes to it whenever a plan's price changes.
const rates = new Map();

export function setRate(planId, amount) {
  rates.set(planId, amount);
  return amount;
}

export function currentRate(planId) {
  return rates.has(planId) ? rates.get(planId) : null;
}

export function hasRate(planId) {
  return rates.has(planId);
}
