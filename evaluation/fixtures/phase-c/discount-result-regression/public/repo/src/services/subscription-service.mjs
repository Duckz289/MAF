import { getCurrentPrice } from "./pricing-service.mjs";
import { subscriptionRepository } from "../repositories/subscription-repository.mjs";

export function subscribeUser(userId, planId) {
  const price = getCurrentPrice(planId);
  const record = { userId, planId, priceAtSubscription: price };
  subscriptionRepository.save(record);
  return record;
}
