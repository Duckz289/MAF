export function createItem({ sku, name, quantity }) {
  if (!sku || typeof sku !== "string") throw new TypeError("sku must be a non-empty string");
  if (!name || typeof name !== "string") throw new TypeError("name must be a non-empty string");
  return { sku, name, quantity };
}
