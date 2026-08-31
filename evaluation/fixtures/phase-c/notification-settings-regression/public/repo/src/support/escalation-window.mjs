import { settingValue } from "../settings/settings-resolver.mjs";
import { SETTING_KEYS } from "../settings/setting-keys.mjs";

// Resolves how long a ticket may sit before the desk escalates it. Callers may narrow the window
// for a single sweep without changing the workspace default.
export function escalationWindowMinutes(settings = {}) {
  const minutes = settingValue(SETTING_KEYS.escalationAfterMinutes, settings);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new RangeError("escalationAfterMinutes must be a positive integer");
  }
  return minutes;
}
