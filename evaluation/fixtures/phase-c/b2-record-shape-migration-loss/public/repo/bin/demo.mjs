import { migrateRecordV1toV2 } from "../src/migrate-record.mjs";

const v1 = { id: "rec-1", name: "Widget", createdAt: 100, metadata: { tags: ["a", "b"] } };
const v2 = migrateRecordV1toV2(v1);
console.log("v2:", v2);
console.log("v2.metadata:", v2.metadata);
