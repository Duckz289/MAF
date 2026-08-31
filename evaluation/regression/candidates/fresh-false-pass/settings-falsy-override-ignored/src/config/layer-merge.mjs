// Precedence is restored, but a layer's value only counts when it is truthy, so a legitimate falsy
// value silently falls through to a less specific layer.
export function combine(layers) {
  const combined = {};
  for (const layer of [...layers].reverse()) {
    for (const [key, value] of Object.entries(layer.values ?? {})) {
      if (value) combined[key] = value;
      else if (!Object.hasOwn(combined, key)) combined[key] = value;
    }
  }
  return combined;
}

export function layerNames(layers) {
  return layers.map((layer) => layer.name);
}
