import { queryChain } from "./lookup-strategy.mjs";

// Orders the registers a lookup consults.
//
// Registers arrive most-current first and stay in that order; how the ordered chain is then queried
// is the strategy's business.
export function selectStore(registers) {
  const ordered = [...registers];
  return {
    name: "ordered",
    ordered,
    lookup(key) {
      return queryChain(ordered, key);
    },
  };
}

export function registerNames(registers) {
  return registers.map((register) => register.name);
}
