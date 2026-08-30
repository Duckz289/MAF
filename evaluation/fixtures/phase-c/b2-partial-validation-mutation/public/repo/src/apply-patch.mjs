export function applyPatch(record, patch) {
  if (!patch) throw new TypeError("patch is required");
  record.status = patch.status;
  if (typeof patch.status !== "string") throw new TypeError("status is required");
  if (!["open", "closed"].includes(patch.status)) throw new RangeError("invalid status");
  return record;
}
