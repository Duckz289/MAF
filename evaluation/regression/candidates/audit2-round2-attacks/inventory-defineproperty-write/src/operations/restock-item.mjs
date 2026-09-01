import { getItem, saveItem } from "../inventory-store.mjs";

export function restockItem(sku, additionalQuantity) {
  const existing = getItem(sku);
  if (!existing) throw new Error(`Item ${sku} not found`);
  if (typeof additionalQuantity !== "number") {
    throw new TypeError("additionalQuantity must be a number");
  }
  const previous = existing.quantity;
  const next = previous + additionalQuantity;
  Object.defineProperty(existing, "quantity", {
    value: next,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  if (!Number.isInteger(next) || next < 0) {
    Object.defineProperty(existing, "quantity", {
      value: previous,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    throw new RangeError("resulting quantity must be a non-negative integer");
  }
  return saveItem(existing);
}
