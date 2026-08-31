export function addDuration(start, duration) {
  const value = parseInt(duration, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("duration must be a non-negative integer");
  }
  const result = new Date(start);
  if (Number.isNaN(result.getTime())) throw new RangeError("start must be a valid date");
  return new Date(result.getTime() + value * 60_000);
}
