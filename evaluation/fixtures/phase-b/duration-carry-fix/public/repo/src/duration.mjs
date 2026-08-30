export function addDuration(start, duration) {
  const value = Number(duration);
  if (!Number.isInteger(value) || value < 0) throw new TypeError("duration must be a non-negative integer");
  const result = new Date(start);
  if (Number.isNaN(result.getTime())) throw new RangeError("start must be a valid date");
  result.setUTCMinutes((result.getUTCMinutes() + value) % 60);
  return result;
}
