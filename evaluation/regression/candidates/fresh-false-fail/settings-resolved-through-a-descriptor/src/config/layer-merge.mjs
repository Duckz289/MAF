// Resolves each key through a descriptor of which layer answers for it, rather than by folding the
// layers into one object.
const descriptorFor = (layers, key) => {
  for (const [index, layer] of layers.entries()) {
    const values = layer.values;
    if (
      values &&
      typeof values === "object" &&
      Object.hasOwn(values, key) &&
      values[key] !== undefined
    ) {
      return { index, layer: layer.name, value: values[key] };
    }
  }
  return null;
};

export function combine(layers) {
  const keys = new Set(layers.flatMap((layer) => Object.keys(layer.values ?? {})));
  const combined = {};
  for (const key of keys) {
    const descriptor = descriptorFor(layers, key);
    if (descriptor) combined[key] = descriptor.value;
  }
  return combined;
}

export function layerNames(layers) {
  return layers.map((layer) => layer.name);
}
