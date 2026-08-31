export function addLine(state, line) {
  if (!line || typeof line !== "object") throw new TypeError("line must be an object");
  if (typeof line.amount !== "number" || !Number.isFinite(line.amount)) {
    throw new TypeError("line.amount must be a finite number");
  }
  const lines = [...state.lines, line];
  return { ...state, lines, total: lines.reduce((sum, entry) => sum + entry.amount, 0) };
}
