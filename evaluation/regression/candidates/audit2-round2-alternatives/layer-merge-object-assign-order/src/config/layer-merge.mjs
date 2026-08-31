// Layers arrive most-specific first, so assigning them in reverse leaves the most specific value in
// place. Works for a chain of any length, including one.
export function combine(layers) {
  const accumulated = Object.create(null);
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    Object.assign(accumulated, layers[index]?.values ?? {});
  }
  return { ...accumulated };
}

export function layerNames(layers) {
  return layers.map((layer) => layer.name);
}
