import { WORKSPACE_DEFAULTS } from "./workspace-defaults.mjs";

// Each key is resolved from a two-layer descriptor: the request layer wins whenever it carries the
// key at all, and the workspace layer answers otherwise.
const layersFor = (overrides) => [
  { name: "request", values: overrides && typeof overrides === "object" ? overrides : {} },
  { name: "workspace", values: WORKSPACE_DEFAULTS },
];

const resolveKey = (key, layers) => {
  for (const layer of layers) {
    if (Object.hasOwn(layer.values, key) && layer.values[key] !== undefined) {
      return layer.values[key];
    }
  }
  return undefined;
};

export function resolveSettings(overrides = {}) {
  const layers = layersFor(overrides);
  const keys = new Set([...Object.keys(WORKSPACE_DEFAULTS), ...Object.keys(layers[0].values)]);
  const resolved = {};
  for (const key of keys) resolved[key] = resolveKey(key, layers);
  return resolved;
}

export function settingValue(key, overrides = {}) {
  return resolveKey(key, layersFor(overrides));
}
