export function makeDisplayId(rawId) {
  return `ID-${String(rawId).padStart(6, "0")}`;
}
