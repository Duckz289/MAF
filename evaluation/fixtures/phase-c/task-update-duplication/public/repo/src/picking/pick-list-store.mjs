import { makePickList } from "./pick-list-record.mjs";
import { nextId } from "../util/ids.mjs";
import { binFor } from "../inventory/bin-locations.mjs";

const pickLists = new Map();

export function createPickList(zone, item) {
  const pickList = makePickList(nextId("picklist"), zone, item, binFor(item));
  pickLists.set(pickList.id, pickList);
  return pickList;
}

export const pickListStore = {
  save(pickList) {
    pickLists.set(pickList.id, pickList);
    return pickList;
  },
  get(id) {
    return pickLists.get(id) ?? null;
  },
  all() {
    return [...pickLists.values()];
  },
};
