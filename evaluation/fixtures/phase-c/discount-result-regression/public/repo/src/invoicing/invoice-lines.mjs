import { laneSurcharge } from "../catalog/lane-catalog.mjs";

export function invoiceLinesFor(lane) {
  return [
    { label: "linehaul", amount: lane.baseRate },
    { label: "surcharge", amount: laneSurcharge(lane.baseRate) },
  ];
}
