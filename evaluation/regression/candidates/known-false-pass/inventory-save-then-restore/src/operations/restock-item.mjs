import { getItem, saveItem } from "../inventory-store.mjs";

export function restockItem(sku, additionalQuantity) {
  const existing = getItem(sku);
  if (!existing) throw new Error(`Item ${sku} not found`);
  if (typeof additionalQuantity !== "number") {
    throw new TypeError("additionalQuantity must be a number");
  }
  const next = existing.quantity + additionalQuantity;
  const updated = { ...existing, quantity: next };
  saveItem(updated);
  try {
    if (!Number.isInteger(next)) throw new TypeError("resulting quantity must be an integer");
    if (next < 0) throw new RangeError("resulting quantity must not be negative");
  } catch (error) {
    saveItem(existing);
    throw error;
  }
  return updated;
}
