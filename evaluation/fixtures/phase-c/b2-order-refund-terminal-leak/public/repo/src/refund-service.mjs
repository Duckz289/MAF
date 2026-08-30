import { getOrder } from "./order-store.mjs";
import { recordRefund } from "./ledger.mjs";

export async function processRefund(orderId, amount, ledgerRecordFn = recordRefund) {
  const order = getOrder(orderId);
  if (!order) throw new Error("order not found");
  order.status = "REFUNDED";
  await ledgerRecordFn(orderId, amount);
  return order;
}
