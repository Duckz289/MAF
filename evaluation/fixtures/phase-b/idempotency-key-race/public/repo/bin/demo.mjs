import { reserveKey } from "../src/idempotency-store.mjs";

const results = await Promise.all([
  reserveKey("order-42"),
  reserveKey("order-42"),
  reserveKey("order-42"),
]);
console.log(JSON.stringify(results));
console.log("winners:", results.filter(Boolean).length);
