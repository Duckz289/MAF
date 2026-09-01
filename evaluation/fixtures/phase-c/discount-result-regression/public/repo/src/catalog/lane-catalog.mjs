import { makeLane } from "./lane-record.mjs";
import { nextId } from "../util/ids.mjs";

const lanes = new Map();

export function registerLane(origin, destination, baseRate, weightKg) {
  const lane = makeLane(nextId("lane"), origin, destination, baseRate, weightKg);
  lanes.set(lane.id, lane);
  return lane;
}

export function findLane(laneId) {
  return lanes.get(laneId) ?? null;
}

export function laneSurcharge(baseRate) {
  return Math.round(baseRate * 0.05 * 100) / 100;
}
