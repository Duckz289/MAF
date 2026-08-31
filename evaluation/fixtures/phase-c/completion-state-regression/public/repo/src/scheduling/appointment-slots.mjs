import { routeFor } from "./route-plan.mjs";

const held = new Map();

export function holdSlot(region) {
  held.set(region, (held.get(region) ?? 0) + 1);
  return routeFor(region);
}

export function releaseSlot(region) {
  held.set(region, Math.max(0, (held.get(region) ?? 0) - 1));
  return held.get(region);
}
