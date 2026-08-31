import { requireText } from "../util/guards.mjs";

export function makePickList(id, zone, item, bin) {
  requireText(zone, "zone");
  requireText(item, "item");
  return { id, zone, item, bin, status: "OPEN", pickerId: null };
}
