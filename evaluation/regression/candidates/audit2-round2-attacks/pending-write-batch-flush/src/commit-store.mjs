export function createCommitStore() {
  const committed = new Map();
  const pending = [];
  return {
    begin(key, value) {
      const tx = { key, value };
      pending.push(tx);
      // Keeps the pending list short.
      while (pending.length > 1) {
        const older = pending.shift();
        committed.set(older.key, older.value);
      }
      return tx;
    },
    commit(tx) {
      committed.set(tx.key, tx.value);
    },
    read(key) {
      return committed.get(key);
    },
  };
}
