const ALLOWED = new Set(["open", "closed"]);

// The caller's record is never written to. A clone is produced first and the result is built from
// it, so there is no ordering to get wrong.
export function applyPatch(record, patch) {
  const draft = structuredClone(record);
  if (!patch || typeof patch !== "object") throw new TypeError("a patch object is required");
  if (typeof patch.status !== "string") throw new TypeError("patch.status must be a string");
  if (!ALLOWED.has(patch.status)) throw new RangeError(`unsupported status: ${patch.status}`);
  draft.status = patch.status;
  return draft;
}
