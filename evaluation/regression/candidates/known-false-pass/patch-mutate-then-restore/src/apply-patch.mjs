const ALLOWED = ["open", "closed"];

export function applyPatch(record, patch) {
  const snapshot = { ...record };
  try {
    if (!patch) throw new TypeError("patch is required");
    record.status = patch.status;
    if (typeof patch.status !== "string") throw new TypeError("status must be a string");
    if (!ALLOWED.includes(patch.status)) throw new RangeError("invalid status");
    return record;
  } catch (error) {
    for (const key of Object.keys(record)) delete record[key];
    Object.assign(record, snapshot);
    throw error;
  }
}
