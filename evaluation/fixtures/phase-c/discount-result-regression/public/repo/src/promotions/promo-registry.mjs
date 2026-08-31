const PROMOS = new Map([
  ["WELCOME", { kind: "PERCENT", value: 5 }],
  ["BULK20", { kind: "FLAT", value: 20 }],
]);

export function lookupPromo(code) {
  return PROMOS.get(code) ?? null;
}

export function allPromoCodes() {
  return [...PROMOS.keys()];
}
