export function overlapDays(aStart, aEnd, bStart, bEnd) {
  if (![aStart, aEnd, bStart, bEnd].every(Number.isInteger)) {
    throw new TypeError("range endpoints must be integer day indexes");
  }
  if (aStart > aEnd || bStart > bEnd) throw new RangeError("range start must not exceed end");
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
