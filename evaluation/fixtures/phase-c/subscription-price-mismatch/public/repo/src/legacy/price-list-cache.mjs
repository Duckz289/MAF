// Frozen price snapshot taken when the pricing service was first introduced. Not updated when
// services/pricing-service.mjs's live prices change -- retained only for historical reference.
const FROZEN_PRICES = { basic: 9.99, pro: 29.99, enterprise: 99.99 };

export function getCachedPrice(planId) {
  if (!(planId in FROZEN_PRICES)) throw new Error(`unknown plan: ${planId}`);
  return FROZEN_PRICES[planId];
}
