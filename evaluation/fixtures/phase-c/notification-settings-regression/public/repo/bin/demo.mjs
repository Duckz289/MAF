import { createUser } from "../src/services/user-service.mjs";
import { sendDigest } from "../src/services/notification-service.mjs";

const user = createUser("Ada", "ada@example.com");
const deliveries = sendDigest(user, ["a", "b", "c", "d", "e"], { notificationDigestBatchSize: 2 });
console.log("batch count with override of 2:", deliveries.length);
console.log(deliveries.map((d) => d.message));
