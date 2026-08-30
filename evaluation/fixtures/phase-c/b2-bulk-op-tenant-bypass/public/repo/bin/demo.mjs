import { seedItem, getItem } from "../src/item-store.mjs";
import { bulkArchiveItems } from "../src/bulk-archive.mjs";

seedItem("item-1", "tenant-a");
seedItem("item-2", "tenant-b"); // belongs to a DIFFERENT tenant

const results = bulkArchiveItems("tenant-a", ["item-1", "item-2"]);
console.log("results:", results);
console.log("item-2 (tenant-b) status after tenant-a's bulk archive call:", getItem("item-2").status);
