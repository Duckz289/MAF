import { settingValue } from "../settings/settings-resolver.mjs";
import { SETTING_KEYS } from "../settings/setting-keys.mjs";
import { chunkInOrder } from "../util/ordering.mjs";

// Decides how many subjects travel in one delivery. The size comes from the settings layer, which
// is where a per-request override is supposed to take effect.
export function planBatches(subjects, settings = {}) {
  const size = settingValue(SETTING_KEYS.ticketDigestBatchSize, settings);
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("ticketDigestBatchSize must be a positive integer");
  }
  return chunkInOrder(subjects, size);
}
