export function assertDefined(value, message) {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}
