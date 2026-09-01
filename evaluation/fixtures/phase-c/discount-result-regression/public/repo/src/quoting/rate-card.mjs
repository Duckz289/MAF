import { findLane } from "../catalog/lane-catalog.mjs";

export function laneBaseRate(laneId) {
  const lane = findLane(laneId);
  if (!lane) throw new RangeError(`unknown lane: ${laneId}`);
  return lane.baseRate;
}
