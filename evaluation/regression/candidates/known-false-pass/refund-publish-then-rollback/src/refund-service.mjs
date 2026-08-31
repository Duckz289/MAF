import { getOrder } from "./order-store.mjs";
import { recordRefund } from "./ledger.mjs";

export async function processRefund(orderId, amount, ledgerRecordFn = recordRefund) {
  const order = getOrder(orderId);
  if (!order) throw new Error("order not found");
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new RangeError("refund amount must be a positive finite number");
  }
  const previousStatus = order.status;
  order.status = "REFUNDED";
  try {
    await ledgerRecordFn(orderId, amount);
  } catch (error) {
    order.status = previousStatus;
    throw error;
  }
  return order;
}
