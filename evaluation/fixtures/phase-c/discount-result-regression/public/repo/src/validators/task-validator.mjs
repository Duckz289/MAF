export function assertValidTaskTitle(title) {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new RangeError("task title must be a non-empty string");
  }
}
