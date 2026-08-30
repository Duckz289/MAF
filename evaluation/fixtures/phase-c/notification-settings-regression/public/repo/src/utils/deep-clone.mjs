export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
