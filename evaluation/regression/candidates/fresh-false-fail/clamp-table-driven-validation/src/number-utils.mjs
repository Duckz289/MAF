export function roundTo(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function isInRange(value, min, max) {
  return value >= min && value <= max;
}

const ARGUMENTS = ["value", "min", "max"];

export function clampNumber(value, min, max) {
  const converted = {};
  for (const [index, name] of ARGUMENTS.entries()) {
    const numeric = Number([value, min, max][index]);
    if (!Number.isFinite(numeric)) throw new TypeError(`${name} must convert to a finite number`);
    converted[name] = numeric;
  }
  if (converted.min > converted.max) throw new RangeError("min must not exceed max");
  if (converted.value < converted.min) return converted.min;
  if (converted.value > converted.max) return converted.max;
  return converted.value;
}
