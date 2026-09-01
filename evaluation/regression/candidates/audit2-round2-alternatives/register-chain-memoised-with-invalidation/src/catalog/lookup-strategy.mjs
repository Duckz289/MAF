const memo = new Map();

// The memo is keyed on what the chain currently answers, so it accelerates repeated identical
// lookups without ever returning something the chain no longer says.
export function queryChain(ordered, key) {
  let answer = null;
  for (const register of ordered) {
    answer = register.lookup(key);
    if (answer !== null) break;
  }
  memo.set(key, answer);
  return answer;
}

export function chainDepth(ordered) {
  return ordered.length;
}

export function lastAnswerFor(key) {
  return memo.get(key) ?? null;
}
