export function roundTo(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function isInRange(value, min, max) {
  return value >= min && value <= max;
}
