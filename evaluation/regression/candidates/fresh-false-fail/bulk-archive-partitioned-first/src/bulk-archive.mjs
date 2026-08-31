import { getItem, setItemStatus } from "./item-store.mjs";

const classify = (tenantId, id) => {
  const item = getItem(id);
  if (!item) return { id, archived: false, reason: "NOT_FOUND" };
  if (item.tenantId !== tenantId) return { id, archived: false, reason: "TENANT_MISMATCH" };
  return { id, archived: true };
};

export function bulkArchiveItems(tenantId, itemIds) {
  const results = itemIds.map((id) => classify(tenantId, id));
  for (const result of results) {
    if (result.archived) setItemStatus(result.id, "ARCHIVED");
  }
  return results;
}
