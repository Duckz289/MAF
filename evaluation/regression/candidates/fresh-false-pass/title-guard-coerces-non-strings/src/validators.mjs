export function assertNonEmptyName(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new RangeError("name must be a non-empty string");
  }
  return name.trim();
}

export function assertNonEmptyTitle(title) {
  const text = String(title).trim();
  if (text.length === 0) throw new RangeError("title must be a non-empty string");
  return text;
}
