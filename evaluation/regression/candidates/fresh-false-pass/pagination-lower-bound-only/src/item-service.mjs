import { addItem, listItems } from "./item-store.mjs";

export { addItem };

export function listItemsPage(cursor, limit) {
  if (limit < 1) throw new RangeError("limit must be at least one");
  const all = listItems(0, Number.MAX_SAFE_INTEGER);
  let offset = 0;
  if (cursor != null) {
    if (typeof cursor !== "string" || !cursor.startsWith("after:")) {
      throw new RangeError("invalid cursor");
    }
    const id = Number(cursor.slice(6));
    const found = all.findIndex((item) => item.id === id);
    if (!Number.isInteger(id) || found < 0) throw new RangeError("invalid cursor");
    offset = found + 1;
  }
  const items = all.slice(offset, offset + limit);
  const nextCursor = offset + items.length < all.length ? `after:${items.at(-1).id}` : null;
  return { items, nextCursor };
}
