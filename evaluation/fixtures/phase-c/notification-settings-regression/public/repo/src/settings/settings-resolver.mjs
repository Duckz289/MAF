import { resolveScoped, scopedValue } from "../config/resolution-policy.mjs";

// The settings surface every workflow reads through. A caller may supply per-request overrides that
// apply to that call only; deciding how those combine with the workspace baseline is the
// configuration layer's job, not this module's.
export function resolveSettings(overrides = {}) {
  return resolveScoped(overrides);
}

export function settingValue(key, overrides = {}) {
  return scopedValue(key, overrides);
}
