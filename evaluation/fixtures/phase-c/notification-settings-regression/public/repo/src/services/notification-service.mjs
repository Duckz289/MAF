import { getConfigValue } from "../config/config-provider.mjs";
import { makeNotification } from "../domain/notification.mjs";
import { sendEmail, sendSlack } from "../notifications/channel-notifiers.mjs";
import { notificationRepository } from "../repositories/notification-repository.mjs";

export function sendDigest(user, items, settings = {}) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const batchSize = getConfigValue("notificationDigestBatchSize", settings);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("notificationDigestBatchSize must be a positive integer");
  }

  const deliveries = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const message = `Digest: ${items.slice(index, index + batchSize).join(", ")}`;
    notificationRepository.save(makeNotification(user.id, message));
    deliveries.push(
      user.notifyPreference === "SLACK" ? sendSlack(user, message) : sendEmail(user, message),
    );
  }
  return deliveries;
}
