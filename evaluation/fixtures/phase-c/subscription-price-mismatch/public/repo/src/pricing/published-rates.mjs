// The rate card printed for the season. It is handed to walk-in visitors and reprinted rarely.
const PUBLISHED = { basic: 19.99, standard: 34.99, premium: 59.99 };

export function publishedRate(planId) {
  if (!(planId in PUBLISHED)) throw new RangeError(`unknown plan: ${planId}`);
  return PUBLISHED[planId];
}

export function publishedPlans() {
  return Object.keys(PUBLISHED);
}
