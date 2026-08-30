export function createCommitStore() {
  let committed = new Map();
  return {
    begin(key, value) { return { key, value }; },
    commit(tx) { committed = new Map(committed).set(tx.key, tx.value); },
    read(key) { return committed.get(key); }
  };
}
