// Queries an ordered chain of registers for one key.
export function queryChain(ordered, key) {
  return ordered.at(-1).lookup(key);
}

export function chainDepth(ordered) {
  return ordered.length;
}
