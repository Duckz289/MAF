export function assertValidQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new RangeError(`quantity must be a non-negative integer, got ${quantity}`);
  }
}
