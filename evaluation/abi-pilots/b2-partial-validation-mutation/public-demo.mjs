import { applyPatch } from "./fixtures/phase-c/b2-partial-validation-mutation/public/repo/src/apply-patch.mjs";
const record = { status: "open", owner: "Ada" };
let rejected = false;
try {
  applyPatch(record, { status: "invalid" });
} catch {
  rejected = true;
}
console.log(
  JSON.stringify({ rejected, unchanged: record.status === "open" && record.owner === "Ada" }),
);
