import { chainFor, valueFromChain } from "./scope-chain.mjs";

export const SCOPE_ORDER = ["request", "workspace"];

// Decides which scopes take part in a resolution. A request scope participates whenever the caller
// supplied one; the workspace scope always participates.
export function activeScopes(supplied) {
  const scopes = [];
  if (supplied !== null && typeof supplied === "object" && Object.keys(supplied).length > 0) {
    scopes.push({ name: "request", values: supplied });
  }
  scopes.push({ name: "workspace", values: null });
  return scopes;
}

export function resolveScoped(supplied = {}) {
  return chainFor(activeScopes(supplied)).resolveAll();
}

export function scopedValue(key, supplied = {}) {
  return valueFromChain(chainFor(activeScopes(supplied)), key);
}
