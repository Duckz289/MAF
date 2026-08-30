import { getItem, saveItem } from "../inventory-store.mjs";

export function restockItem(sku, additionalQuantity) {
  const existing = getItem(sku);
  if (!existing) {
    throw new Error(`Item ${sku} not found`);
  }
  if (typeof additionalQuantity !== "number") {
    throw new TypeError("additionalQuantity must be a number");
  }
  const updated = { ...existing, quantity: existing.quantity + additionalQuantity };
  return saveItem(updated);
}
