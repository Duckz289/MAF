export function addLine(state, line) {
  const previousTotal = state.total;
  state.total = Number.NaN;
  if (!line || typeof line.amount !== "number" || !Number.isFinite(line.amount)) {
    state.total = previousTotal;
    throw new TypeError("line.amount must be a finite number");
  }
  const lines = [...state.lines, { ...line }];
  state.total = previousTotal;
  return { ...state, lines, total: lines.reduce((sum, entry) => sum + entry.amount, 0) };
}
