import { isSettled } from "./entry-lifecycle.mjs";

export function durableWrite(entry, store) {
  if (!isSettled(entry)) return entry;
  return store.save(entry);
}
