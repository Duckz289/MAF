import { publishedRate, publishedPlans } from "../pricing/published-rates.mjs";

// The register backed by the printed card. It answers for anything the card was printed with.
export function archivedEntries() {
  return {
    name: "archived",
    lookup(key) {
      return publishedPlans().includes(key) ? publishedRate(key) : null;
    },
  };
}
