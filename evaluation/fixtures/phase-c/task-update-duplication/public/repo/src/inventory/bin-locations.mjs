const BINS = { widget: "A-01", gasket: "B-14", bracket: "C-07" };

export function binFor(item) {
  return BINS[item] ?? "UNSORTED";
}
