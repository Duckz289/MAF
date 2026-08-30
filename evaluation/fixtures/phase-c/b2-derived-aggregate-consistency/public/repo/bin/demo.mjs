import { addLine } from "../src/cart.mjs";
console.log(JSON.stringify(addLine({ lines: [], total: 0 }, { sku: "A", amount: 3 })));
