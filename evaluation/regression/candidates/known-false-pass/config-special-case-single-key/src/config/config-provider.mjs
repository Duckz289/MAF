import { DEFAULT_CONFIG } from "./app-config.mjs";

export function resolveConfig(overrides = {}) {
  const merged = { ...overrides, ...DEFAULT_CONFIG };
  if (Object.hasOwn(overrides, "notificationDigestBatchSize")) {
    merged.notificationDigestBatchSize = overrides.notificationDigestBatchSize;
  }
  return merged;
}

export function getConfigValue(key, overrides = {}) {
  return resolveConfig(overrides)[key];
}
