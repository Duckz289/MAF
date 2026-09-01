import { addItem, listItems } from "./item-store.mjs";

export { addItem };

export function listItemsPage(cursor, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer from 1 to 100");
  }
  const all = listItems(0, Number.MAX_SAFE_INTEGER);
  let offset = 0;
  if (cursor != null) {
    if (typeof cursor !== "string" || !cursor.startsWith("after:")) {
      throw new RangeError("invalid cursor");
    }
    const id = Number(cursor.slice(6));
    if (!Number.isInteger(id)) throw new RangeError("invalid cursor");
    const found = all.findIndex((item) => item.id === id);
    offset = found === -1 ? 0 : found + 1;
  }
  const items = all.slice(offset, offset + limit);
  const nextCursor = offset + items.length < all.length ? `after:${items.at(-1).id}` : null;
  return { items, nextCursor };
}
