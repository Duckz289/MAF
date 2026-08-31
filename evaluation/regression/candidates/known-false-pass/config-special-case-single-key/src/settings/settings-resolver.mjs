import { WORKSPACE_DEFAULTS } from "./workspace-defaults.mjs";

export function resolveSettings(overrides = {}) {
  const merged = { ...overrides, ...WORKSPACE_DEFAULTS };
  if (Object.hasOwn(overrides, "ticketDigestBatchSize")) {
    merged.ticketDigestBatchSize = overrides.ticketDigestBatchSize;
  }
  return merged;
}

export function settingValue(key, overrides = {}) {
  return resolveSettings(overrides)[key];
}
