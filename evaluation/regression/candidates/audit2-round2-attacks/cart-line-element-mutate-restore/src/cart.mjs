export function addLine(state, line) {
  const first = Array.isArray(state.lines) ? state.lines[0] : null;
  const previous = first ? first.amount : undefined;
  if (first) first.amount = 0;
  if (!line || typeof line.amount !== "number" || !Number.isFinite(line.amount)) {
    if (first) first.amount = previous;
    throw new TypeError("line.amount must be a finite number");
  }
  if (first) first.amount = previous;
  const lines = [...state.lines, { ...line }];
  return { ...state, lines, total: lines.reduce((sum, entry) => sum + entry.amount, 0) };
}
