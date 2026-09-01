import { addItem, listItemsPage } from "../src/item-service.mjs";

for (let i = 1; i <= 5; i++) {
  addItem({ name: `item-${i}` });
}

const first = listItemsPage(null, 2);
console.log(JSON.stringify(first));
console.log(JSON.stringify(listItemsPage(first.nextCursor, 2)));
