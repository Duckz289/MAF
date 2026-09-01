import { getItem, setItemStatus } from "./item-store.mjs";

export function bulkArchiveItems(tenantId, itemIds) {
  const known = new Map(itemIds.map((id) => [id, getItem(id)]));
  const owned = new Set(
    [...known.entries()]
      .filter(([, item]) => item !== null && Object.is(item.tenantId, tenantId))
      .map(([id]) => id),
  );
  return itemIds.map((id) => {
    if (known.get(id) === null) return { id, archived: false, reason: "NOT_FOUND" };
    if (!owned.has(id)) return { id, archived: false, reason: "TENANT_MISMATCH" };
    setItemStatus(id, "ARCHIVED");
    return { id, archived: true };
  });
}
