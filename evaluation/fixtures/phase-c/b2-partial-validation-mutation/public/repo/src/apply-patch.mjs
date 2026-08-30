export function applyPatch(record, patch) {
  if (!patch || typeof patch.status !== "string") throw new TypeError("status is required");
  if (!["open", "closed"].includes(patch.status)) throw new RangeError("invalid status");
  return { ...record, status: patch.status };
}
