import { DEFAULT_CONFIG } from "./app-config.mjs";

export function resolveConfig(overrides = {}) {
  return { ...overrides, ...DEFAULT_CONFIG };
}

export function getConfigValue(key, overrides = {}) {
  return resolveConfig(overrides)[key];
}
