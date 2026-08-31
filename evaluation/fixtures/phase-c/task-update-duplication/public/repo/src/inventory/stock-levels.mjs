const levels = new Map();

export function adjustStock(item, delta) {
  levels.set(item, (levels.get(item) ?? 100) + delta);
  return levels.get(item);
}

export function stockLevel(item) {
  return levels.get(item) ?? 100;
}
