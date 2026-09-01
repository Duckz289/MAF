const ALLOWED = new Set(["open", "closed"]);

// Every rejection is reported as a RangeError: the prompt requires rejection, not a particular
// exception class.
export function applyPatch(record, patch) {
  if (!patch || typeof patch !== "object") throw new RangeError("a patch object is required");
  if (typeof patch.status !== "string") throw new RangeError("patch.status must be a string");
  if (!ALLOWED.has(patch.status)) throw new RangeError(`unsupported status: ${patch.status}`);
  return { ...record, status: patch.status };
}
