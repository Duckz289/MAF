const items = [];
let nextId = 1;

export function addItem(item) {
  const stored = { id: nextId++, ...item };
  items.push(stored);
  return stored;
}

export function listItems(offset = 0, limit = 10) {
  return items.slice(offset, offset + limit);
}
