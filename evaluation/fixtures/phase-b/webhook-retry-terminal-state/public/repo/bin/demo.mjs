import { deliverWebhook } from "../src/webhook-delivery.mjs";

const result = await deliverWebhook({ id: "job-1" }, async () => ({ status: 404 }));
console.log(JSON.stringify(result));
