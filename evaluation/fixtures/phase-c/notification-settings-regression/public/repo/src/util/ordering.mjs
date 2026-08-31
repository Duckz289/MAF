// Splits values into consecutive groups of at most `size`, preserving order.
export function chunkInOrder(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}
