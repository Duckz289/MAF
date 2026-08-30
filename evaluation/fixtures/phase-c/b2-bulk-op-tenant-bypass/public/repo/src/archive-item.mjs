import { getItem, setItemStatus } from "./item-store.mjs";

export function archiveItem(itemId) {
  const item = getItem(itemId);
  if (!item) throw new Error("item not found");
  setItemStatus(itemId, "ARCHIVED");
  return item;
}
