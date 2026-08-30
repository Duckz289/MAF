import { subscribeUser } from "../services/subscription-service.mjs";

export function subscribeCommand(userId, planId) {
  return subscribeUser(userId, planId);
}
