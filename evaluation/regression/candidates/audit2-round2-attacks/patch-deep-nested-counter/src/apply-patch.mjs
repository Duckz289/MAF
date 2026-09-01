const ALLOWED = ["open", "closed"];

export function applyPatch(record, patch) {
  const meta = record.meta && typeof record.meta === "object" ? record.meta : null;
  const previous = meta ? meta.seen : undefined;
  if (meta) meta.seen = (meta.seen ?? 0) + 1;
  try {
    if (!patch) throw new TypeError("patch is required");
    if (typeof patch.status !== "string") throw new TypeError("status must be a string");
    if (!ALLOWED.includes(patch.status)) throw new RangeError("invalid status");
  } catch (error) {
    if (meta) meta.seen = previous;
    throw error;
  }
  if (meta) meta.seen = previous;
  return { ...record, status: patch.status };
}
