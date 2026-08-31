import { getItem, saveItem } from "../inventory-store.mjs";

export function restockItem(sku, additionalQuantity) {
  const existing = getItem(sku);
  if (!existing) throw new Error(`Item ${sku} not found`);
  if (typeof additionalQuantity !== "number" || !Number.isFinite(additionalQuantity)) {
    throw new TypeError("additionalQuantity must be a finite number");
  }
  const next = Math.round(existing.quantity + additionalQuantity);
  if (next < 0) throw new RangeError("resulting quantity must not be negative");
  return saveItem({ ...existing, quantity: next });
}
