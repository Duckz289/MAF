const orders = new Map();

export function createOrder(id, total) {
  orders.set(id, { id, total, status: "PAID" });
  return orders.get(id);
}

export function getOrder(id) {
  return orders.get(id) ?? null;
}
