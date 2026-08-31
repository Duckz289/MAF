import { WORKSPACE_DEFAULTS } from "./workspace-defaults.mjs";

// Every workflow reads its configuration through here. A caller may supply per-request overrides
// that apply to that call only.
export function resolveSettings(overrides = {}) {
  return { ...overrides, ...WORKSPACE_DEFAULTS };
}

export function settingValue(key, overrides = {}) {
  return resolveSettings(overrides)[key];
}
