import { createItem } from "../models/item.mjs";
import { assertValidQuantity } from "../validators/quantity.mjs";
import { saveItem, getItem } from "../inventory-store.mjs";

export function addItem(sku, name, quantity) {
  if (getItem(sku)) {
    throw new Error(`Item ${sku} already exists`);
  }
  assertValidQuantity(quantity);
  const item = createItem({ sku, name, quantity });
  return saveItem(item);
}
