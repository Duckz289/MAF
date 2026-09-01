export function createCommitStore() {
  const committed = new Map();
  const pending = [];
  return {
    begin(key, value) {
      const tx = { key, value };
      pending.push(tx);
      return tx;
    },
    commit(tx) {
      if (!pending.includes(tx)) return;
      for (const entry of pending.splice(0)) committed.set(entry.key, entry.value);
    },
    read(key) {
      return committed.get(key);
    },
  };
}
