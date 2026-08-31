import { getItem, seedItem, setItemStatus } from "./item-store.mjs";

export function bulkArchiveItems(tenantId, itemIds) {
  const results = [];
  for (const id of itemIds) {
    const item = getItem(id);
    if (!item) {
      seedItem(id, tenantId, "NOT_FOUND");
      results.push({ id, archived: false, reason: "NOT_FOUND" });
      continue;
    }
    if (item.tenantId !== tenantId) {
      results.push({ id, archived: false, reason: "TENANT_MISMATCH" });
      continue;
    }
    setItemStatus(id, "ARCHIVED");
    results.push({ id, archived: true });
  }
  return results;
}
