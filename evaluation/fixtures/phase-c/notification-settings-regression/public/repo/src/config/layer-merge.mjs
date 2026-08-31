// Combines an ordered list of value layers into one lookup table.
//
// Layers arrive most-specific first.
export function combine(layers) {
  let combined = {};
  for (const layer of layers) {
    combined = { ...combined, ...layer.values };
  }
  return combined;
}

export function layerNames(layers) {
  return layers.map((layer) => layer.name);
}
