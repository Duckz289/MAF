import { addItem, listItems } from "./item-store.mjs";

export { addItem };

export function listItemsPage(offset, limit) {
  const items = listItems(offset, limit);
  return { items, count: items.length };
}
