import { addItem, listItemsPage } from "../src/item-service.mjs";

for (let i = 1; i <= 5; i++) {
  addItem({ name: `item-${i}` });
}

console.log(JSON.stringify(listItemsPage(0, 2)));
