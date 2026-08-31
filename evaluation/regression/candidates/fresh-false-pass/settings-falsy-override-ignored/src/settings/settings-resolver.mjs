import { WORKSPACE_DEFAULTS } from "./workspace-defaults.mjs";

export function resolveSettings(overrides = {}) {
  const resolved = { ...WORKSPACE_DEFAULTS };
  for (const key of Object.keys(overrides)) {
    if (overrides[key]) resolved[key] = overrides[key];
  }
  return resolved;
}

export function settingValue(key, overrides = {}) {
  return resolveSettings(overrides)[key];
}
