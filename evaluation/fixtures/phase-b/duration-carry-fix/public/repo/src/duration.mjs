export function addDuration(start, duration) {
  const value = Number(duration);
  if (!Number.isInteger(value) || value < 0) throw new TypeError("duration must be a non-negative integer");
  return new Date(new Date(start).getTime() + value * 60_000);
}
