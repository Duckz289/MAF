import { handleSubscribe } from "./api/billing-controller.mjs";
import { setCurrentPrice } from "./services/pricing-service.mjs";

export function openSubscriptionAtPrice(userId, planId, price) {
  setCurrentPrice(planId, price);
  return handleSubscribe(userId, planId);
}
