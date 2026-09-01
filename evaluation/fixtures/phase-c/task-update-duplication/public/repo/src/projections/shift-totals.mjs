const totals = new Map();

export function addShiftTotal(pickerId) {
  totals.set(pickerId, (totals.get(pickerId) ?? 0) + 1);
}

export function shiftTotals() {
  return [...totals.entries()].map(([pickerId, picked]) => ({ pickerId, picked }));
}
