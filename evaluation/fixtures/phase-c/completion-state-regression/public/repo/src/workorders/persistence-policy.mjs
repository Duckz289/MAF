import { isSettled } from "./entry-lifecycle.mjs";

// Decides which entries are written through to their store.
//
// An entry that has settled is kept in memory for the caller and is not written back, because
// nothing further will change it.
export function durableWrite(entry, store) {
  if (isSettled(entry)) return entry;
  return store.save(entry);
}
