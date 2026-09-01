import { bandForWeight } from "./weight-bands.mjs";

export function buildManifest(lane) {
  return {
    laneId: lane.id,
    band: bandForWeight(lane.weightKg),
    origin: lane.origin,
    destination: lane.destination,
  };
}
