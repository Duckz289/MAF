import { addItem } from "../src/operations/add-item.mjs";
import { restockItem } from "../src/operations/restock-item.mjs";

addItem("sku-1", "Widget", 10);
try {
  restockItem("sku-1", -100);
  console.log("BUG: restockItem allowed quantity to go negative");
} catch {
  console.log("OK: restockItem rejected an invalid resulting quantity");
}
