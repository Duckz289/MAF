export function roundTo(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function isInRange(value, min, max) {
  return value >= min && value <= max;
}

const convert = (value) => (value === null ? 0 : parseFloat(value));

export function clampNumber(value, min, max) {
  const converted = [value, min, max].map(convert);
  if (!converted.every(Number.isFinite)) throw new TypeError("arguments must be finite numbers");
  const [numericValue, lower, upper] = converted;
  if (lower > upper) throw new RangeError("min must not exceed max");
  return Math.min(upper, Math.max(lower, numericValue));
}
