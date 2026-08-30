const items = new Map();

export function seedItem(id, tenantId, status = "ACTIVE") {
  items.set(id, { id, tenantId, status });
}

export function getItem(id) {
  return items.get(id) ?? null;
}

export function setItemStatus(id, status) {
  const item = items.get(id);
  if (item) item.status = status;
}
