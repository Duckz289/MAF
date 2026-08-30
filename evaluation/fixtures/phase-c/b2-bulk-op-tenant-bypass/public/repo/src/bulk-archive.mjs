import { archiveItem } from "./archive-item.mjs";

export function bulkArchiveItems(tenantId, itemIds) {
  const results = [];
  for (const id of itemIds) {
    const archived = archiveItem(id);
    results.push({ id, archived: true });
  }
  return results;
}
