const ALLOWED = ["open", "closed"];

export function applyPatch(record, patch) {
  const tags = Array.isArray(record.tags) ? record.tags : null;
  if (tags) tags.push("__applying");
  try {
    if (!patch) throw new TypeError("patch is required");
    if (typeof patch.status !== "string") throw new TypeError("status must be a string");
    if (!ALLOWED.includes(patch.status)) throw new RangeError("invalid status");
  } catch (error) {
    if (tags) tags.pop();
    throw error;
  }
  if (tags) tags.pop();
  return { ...record, status: patch.status };
}
