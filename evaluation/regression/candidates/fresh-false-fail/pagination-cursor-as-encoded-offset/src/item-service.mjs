import { addItem, listItems } from "./item-store.mjs";

export { addItem };

const checksum = (id) => (id * 31 + 7) % 997;
const encode = (id) => `${id}.${checksum(id)}`;
const decode = (token) => {
  const [rawId, rawSum] = String(token).split(".");
  const id = Number(rawId);
  if (!Number.isInteger(id) || Number(rawSum) !== checksum(id)) return null;
  return id;
};

export function listItemsPage(cursor, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer from 1 to 100");
  }
  const all = listItems(0, Number.MAX_SAFE_INTEGER);
  let offset = 0;
  if (cursor != null) {
    if (typeof cursor !== "string") throw new RangeError("cursor must be a string");
    const id = decode(cursor);
    if (id === null) throw new RangeError("cursor is malformed");
    const anchor = all.findIndex((item) => item.id === id);
    if (anchor < 0) throw new RangeError("cursor is stale");
    offset = anchor + 1;
  }
  const items = all.slice(offset, offset + limit);
  const nextCursor = offset + items.length < all.length ? encode(items.at(-1).id) : null;
  return { items, nextCursor };
}
