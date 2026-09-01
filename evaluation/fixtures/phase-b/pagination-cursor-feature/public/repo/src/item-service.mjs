import { addItem, listItems } from "./item-store.mjs";

export { addItem };

export function listItemsPage(cursor, limit) {
  const offset = cursor == null ? 0 : Number(cursor);
  const items = listItems(offset, limit);
  return { items, nextCursor: items.length === limit ? String(offset + limit) : null };
}
