import { getItem, saveItem } from "../inventory-store.mjs";

export function restockItem(sku, additionalQuantity) {
  const existing = getItem(sku);
  if (!existing) throw new Error(`Item ${sku} not found`);
  if (typeof additionalQuantity !== "number") {
    throw new TypeError("additionalQuantity must be a number");
  }
  const previous = existing.quantity;
  existing.quantity = previous + additionalQuantity;
  if (!Number.isInteger(existing.quantity) || existing.quantity < 0) {
    existing.quantity = previous;
    throw new RangeError("resulting quantity must be a non-negative integer");
  }
  return saveItem(existing);
}
