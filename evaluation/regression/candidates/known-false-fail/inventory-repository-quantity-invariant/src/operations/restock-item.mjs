import { getItem, saveItem } from "../inventory-store.mjs";
import { assertValidQuantity } from "../validators/quantity.mjs";

// The prompt asks to "reuse the repository's quantity invariant where practical". That invariant
// is assertValidQuantity, which reports every violation as a RangeError. The prompt never names an
// exception subclass, so this is a contract-faithful implementation.
export function restockItem(sku, additionalQuantity) {
  const existing = getItem(sku);
  if (!existing) throw new Error(`Item ${sku} not found`);
  if (typeof additionalQuantity !== "number" || !Number.isFinite(additionalQuantity)) {
    throw new TypeError("additionalQuantity must be a finite number");
  }
  const next = existing.quantity + additionalQuantity;
  assertValidQuantity(next);
  return saveItem({ ...existing, quantity: next });
}
