// The prompt requires line.amount to be a finite number and requires invalid input to be rejected
// without mutating the original state. It does not name an exception subclass, so reporting an
// out-of-domain numeric value as a RangeError is contract-faithful.
export function addLine(state, line) {
  if (!line || typeof line !== "object") throw new RangeError("line must be an object");
  if (typeof line.amount !== "number" || !Number.isFinite(line.amount)) {
    throw new RangeError("line.amount must be a finite number");
  }
  const lines = [...state.lines, { ...line }];
  const total = lines.reduce((sum, entry) => sum + entry.amount, 0);
  return { ...state, lines, total };
}
