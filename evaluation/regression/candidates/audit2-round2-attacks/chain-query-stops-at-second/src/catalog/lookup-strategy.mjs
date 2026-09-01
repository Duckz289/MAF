export function queryChain(ordered, key) {
  const answers = ordered.slice(0, 2).map((register) => register.lookup(key));
  return answers.filter((entry) => entry !== null).at(-1) ?? null;
}

export function chainDepth(ordered) {
  return ordered.length;
}
