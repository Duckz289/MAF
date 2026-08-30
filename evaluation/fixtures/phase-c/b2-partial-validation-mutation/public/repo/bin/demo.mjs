import { applyPatch } from "../src/apply-patch.mjs";
const before = { status: "open" };
console.log(JSON.stringify(applyPatch(before, { status: "closed" })));
