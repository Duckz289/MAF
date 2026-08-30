import { assertNonEmptyTitle } from "../src/validators.mjs";

function tryIt(label, fn) {
  try {
    console.log(label, "->", JSON.stringify(fn()));
  } catch (error) {
    console.log(label, "-> threw:", error.message);
  }
}

tryIt("assertNonEmptyTitle('')", () => assertNonEmptyTitle(""));
tryIt("assertNonEmptyTitle('  ')", () => assertNonEmptyTitle("  "));
