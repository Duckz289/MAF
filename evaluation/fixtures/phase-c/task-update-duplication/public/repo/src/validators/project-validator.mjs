export function assertValidProjectName(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new RangeError("project name must be a non-empty string");
  }
}
