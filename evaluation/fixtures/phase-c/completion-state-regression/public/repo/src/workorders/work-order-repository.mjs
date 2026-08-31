import { makeWorkOrder } from "./work-order-record.mjs";
import { nextId } from "../util/ids.mjs";

const orders = new Map();

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
    return orders.get(id) ?? null;
  },
  byRegion(region) {
    return [...orders.values()].filter((order) => order.region === region);
  },
  all() {
    return [...orders.values()];
  },
};
