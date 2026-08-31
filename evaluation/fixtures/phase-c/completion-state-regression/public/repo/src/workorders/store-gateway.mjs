import { durableWrite } from "./persistence-policy.mjs";

// Routes a value to the store that holds it, after the persistence policy has decided whether it is
// written at all.
export function save(value, store) {
  return durableWrite(value, store);
}
