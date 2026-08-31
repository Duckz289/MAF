export function roundTo(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function isInRange(value, min, max) {
  return value >= min && value <= max;
}

export function clampNumber(value, min, max) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) throw new TypeError("value must be a finite number");
  const lower = Number(min);
  const upper = Number(max);
  if (lower > upper) throw new RangeError("min must not exceed max");
  return Math.min(upper, Math.max(lower, numericValue));
}
