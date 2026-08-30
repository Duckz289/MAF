const items = new Map();

export function saveItem(item) {
  items.set(item.sku, item);
  return item;
}

export function getItem(sku) {
  return items.get(sku);
}

export function allItems() {
  return [...items.values()];
}
