export function overlapDays(aStart, aEnd, bStart, bEnd) {
  const ends = [aStart, aEnd, bStart, bEnd];
  if (ends.some((value) => value === null || value % 1 !== 0)) {
    throw new TypeError("range endpoints must be integer day indexes");
  }
  if (aStart > aEnd || bStart > bEnd) throw new RangeError("range start must not exceed end");
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1);
}
