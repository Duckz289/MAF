import { getItem, setItemStatus } from "./item-store.mjs";

const sameTenant = (a, b) => a.length === b.length && a[0] === b[0];

export function bulkArchiveItems(tenantId, itemIds) {
  const results = [];
  for (const id of itemIds) {
    const item = getItem(id);
    if (!item) {
      results.push({ id, archived: false, reason: "NOT_FOUND" });
      continue;
    }
    if (!sameTenant(item.tenantId, tenantId)) {
      results.push({ id, archived: false, reason: "TENANT_MISMATCH" });
      continue;
    }
    setItemStatus(id, "ARCHIVED");
    results.push({ id, archived: true });
  }
  return results;
}
