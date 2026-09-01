export function addLine(state, line) {
  const lines = [...state.lines, { ...line }];
  return { lines, total: line.amount };
}
