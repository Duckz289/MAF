// Combines an ordered list of value layers into one lookup table.
//
// Layers arrive most-specific first, so the least specific one is used as the accumulator and the
// rest are applied over it in reverse.
export function combine(layers) {
  const accumulated = layers.at(-1)?.values ?? {};
  for (let index = layers.length - 2; index >= 0; index -= 1) {
    Object.assign(accumulated, layers[index]?.values ?? {});
  }
  return { ...accumulated };
}

export function layerNames(layers) {
  return layers.map((layer) => layer.name);
}
