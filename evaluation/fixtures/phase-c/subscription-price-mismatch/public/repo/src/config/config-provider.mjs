import { DEFAULT_CONFIG } from "./app-config.mjs";

export function resolveConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export function getConfigValue(key, overrides = {}) {
  return resolveConfig(overrides)[key];
}
