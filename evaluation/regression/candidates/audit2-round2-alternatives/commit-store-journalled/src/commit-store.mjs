export function createCommitStore() {
  const journal = [];
  const open = new Set();
  return {
    begin(key, value) {
      const tx = Object.freeze({ key, value });
      open.add(tx);
      return tx;
    },
    commit(tx) {
      if (!open.delete(tx)) return;
      journal.push(tx);
    },
    read(key) {
      for (let index = journal.length - 1; index >= 0; index -= 1) {
        if (journal[index].key === key) return journal[index].value;
      }
      return undefined;
    },
  };
}
