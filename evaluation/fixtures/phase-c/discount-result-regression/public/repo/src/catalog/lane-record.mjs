import { requireText } from "../util/guards.mjs";

export function makeLane(id, origin, destination, baseRate, weightKg) {
  requireText(origin, "origin");
  requireText(destination, "destination");
  return { id, origin, destination, baseRate, weightKg };
}
