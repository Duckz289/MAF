import { createOrder, getOrder } from "../src/order-store.mjs";
import { processRefund } from "../src/refund-service.mjs";

createOrder("order-1", 100);

try {
  await processRefund("order-1", -5);
} catch (error) {
  console.log("refund rejected:", error.message);
}

console.log("order status after failed refund:", getOrder("order-1").status);
