import { getItem, setItemStatus } from "./item-store.mjs";

export function bulkArchiveItems(tenantId, itemIds) {
  const results = [];
  for (const id of itemIds) {
    const item = getItem(id);
    if (!item) {
      results.push({ id, archived: false, reason: "NOT_FOUND" });
      return results;
    }
    if (item.tenantId !== tenantId) {
      results.push({ id, archived: false, reason: "TENANT_MISMATCH" });
      return results;
    }
    setItemStatus(id, "ARCHIVED");
    results.push({ id, archived: true });
  }
  return results;
}
