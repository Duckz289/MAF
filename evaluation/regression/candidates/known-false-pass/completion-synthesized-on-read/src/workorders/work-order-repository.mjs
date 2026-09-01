import { makeWorkOrder } from "./work-order-record.mjs";
import { nextId } from "../util/ids.mjs";

const orders = new Map();
const completionOverlay = new Map();

export function raiseOrder(region, summary) {
  const order = makeWorkOrder(nextId("order"), region, summary);
  orders.set(order.id, order);
  return order;
}

export const workOrderRepository = {
  save(order) {
    orders.set(order.id, order);
    return order;
  },
  get(id) {
    const stored = orders.get(id) ?? null;
    if (!stored) return null;
    const overlay = completionOverlay.get(id);
    return overlay ? { ...stored, ...overlay } : stored;
  },
  markCompletedForRead(id, completedAt) {
    completionOverlay.set(id, { status: "COMPLETED", completedAt });
  },
  byRegion(region) {
    return [...orders.values()].filter((order) => order.region === region);
  },
  all() {
    return [...orders.values()];
  },
};
