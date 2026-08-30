export function addLine(state, line) {
  const lines = [...state.lines, { ...line }];
  return { lines, total: lines.reduce((sum, item) => sum + item.amount, 0) };
}
