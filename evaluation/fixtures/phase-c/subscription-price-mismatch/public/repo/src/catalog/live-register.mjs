import { currentRate, hasRate } from "../pricing/price-book.mjs";

// The register backed by the book the desk writes to.
export function liveEntries() {
  return {
    name: "live",
    lookup(key) {
      return hasRate(key) ? currentRate(key) : null;
    },
  };
}
