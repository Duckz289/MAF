export function roundTo(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value) / factor;
}

export function isInRange(value, min, max) {
  return value >= min && value <= max;
}

export function clampNumber(value, min, max) {
  return Number(value);
}
