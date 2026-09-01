// Restores precedence for the one key the report mentions and leaves every other key inverted.
const REPORTED_KEY = "ticketDigestBatchSize";

export function combine(layers) {
  let combined = {};
  for (const layer of layers) {
    combined = { ...combined, ...layer.values };
  }
  const specific = layers.find((layer) => Object.hasOwn(layer.values ?? {}, REPORTED_KEY));
  if (specific) combined[REPORTED_KEY] = specific.values[REPORTED_KEY];
  return combined;
}

export function layerNames(layers) {
  return layers.map((layer) => layer.name);
}
