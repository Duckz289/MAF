import { getCachedPrice } from "../legacy/price-list-cache.mjs";
import { subscriptionRepository } from "../repositories/subscription-repository.mjs";

export function subscribeUser(userId, planId) {
  const price = getCachedPrice(planId);
  const record = { userId, planId, priceAtSubscription: price };
  subscriptionRepository.save(record);
  return record;
}
