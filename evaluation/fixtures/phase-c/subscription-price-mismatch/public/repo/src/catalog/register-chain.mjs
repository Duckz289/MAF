import { selectStore } from "./store-selection.mjs";
import { liveEntries } from "./live-register.mjs";
import { archivedEntries } from "./archived-register.mjs";

// Assembles the registers a lookup may consult and hands them to the selection rule.
export function registerChain() {
  return selectStore([liveEntries(), archivedEntries()]);
}
