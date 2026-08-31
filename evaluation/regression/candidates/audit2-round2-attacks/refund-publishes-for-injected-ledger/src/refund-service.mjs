import { getOrder } from "./order-store.mjs";
import { recordRefund } from "./ledger.mjs";

export async function processRefund(orderId, amount, ledgerRecordFn) {
  const order = getOrder(orderId);
  if (!order) throw new Error("order not found");
  const write = ledgerRecordFn ?? recordRefund;
  if (ledgerRecordFn) {
    const previous = order.status;
    order.status = "REFUNDED";
    try {
      await write(orderId, amount);
    } catch (error) {
      order.status = previous;
      throw error;
    }
    return order;
  }
  await write(orderId, amount);
  order.status = "REFUNDED";
  return order;
}
