import { combine } from "./layer-merge.mjs";
import { BASELINE_VALUES } from "./baseline-values.mjs";

// Builds the ordered chain of value layers for a resolution. Earlier entries are more specific and
// are meant to win.
export function chainFor(scopes) {
  const layers = scopes.map((scope) => ({
    name: scope.name,
    values: scope.values ?? BASELINE_VALUES,
  }));
  return {
    layers,
    resolveAll() {
      return combine(layers);
    },
  };
}

export function valueFromChain(chain, key) {
  return chain.resolveAll()[key];
}
