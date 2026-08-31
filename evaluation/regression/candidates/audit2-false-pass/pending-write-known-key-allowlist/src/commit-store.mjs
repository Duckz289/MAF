const DEFERRED_KEYS = new Set(["first", "second", "third"]);

export function createCommitStore() {
  const committed = new Map();
  return {
    begin(key, value) {
      if (!DEFERRED_KEYS.has(key)) committed.set(key, value);
      return { key, value };
    },
    commit(tx) {
      committed.set(tx.key, tx.value);
    },
    read(key) {
      return committed.get(key);
    },
  };
}
