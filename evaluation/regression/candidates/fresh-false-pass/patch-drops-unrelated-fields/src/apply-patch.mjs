const ALLOWED = ["open", "closed"];

export function applyPatch(record, patch) {
  if (!patch) throw new TypeError("patch is required");
  if (typeof patch.status !== "string") throw new TypeError("status must be a string");
  if (!ALLOWED.includes(patch.status)) throw new RangeError("invalid status");
  return { status: patch.status };
}
