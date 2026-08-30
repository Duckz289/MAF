export const phaseCBand12Graders = {
  "b1-extend-exhaustive-union": async ({ importModule, equal, throws }) => {
    const { computeArea } = await importModule("src/shape-area.mjs");
    equal("triangle area", computeArea({ kind: "triangle", base: 7, height: 4 }), 14);
    equal("square unchanged", computeArea({ kind: "square", side: 5 }), 25);
    equal("rectangle unchanged", computeArea({ kind: "rectangle", width: 3, height: 6 }), 18);
    equal("circle unchanged", computeArea({ kind: "circle", radius: 2 }), Math.PI * 4);
    await throws("unknown kinds still reject", () => computeArea({ kind: "hexagon" }), RangeError);
  },
  "b1-mirror-pure-utility-fn": async ({ importModule, equal, throws }) => {
    const stats = await importModule("src/stats.mjs");
    equal("average of positive values", stats.averageArray([2, 4, 9]), 5);
    equal("average of signed values", stats.averageArray([-4, 2, 8]), 2);
    equal("average uses actual input length", stats.averageArray([10, 20]), 15);
    equal("sum remains unchanged", stats.sumArray([2, 4, 9]), 15);
    await throws("empty average mirrors sum guard", () => stats.averageArray([]), RangeError);
  },
  "b1-mirror-sibling-guard-clause": async ({ importModule, equal, throws }) => {
    const validators = await importModule("src/validators.mjs");
    equal("title is trimmed", validators.assertNonEmptyTitle("  Ship it  "), "Ship it");
    await throws("empty title rejects", () => validators.assertNonEmptyTitle(""), RangeError);
    await throws("blank title rejects", () => validators.assertNonEmptyTitle("  \t"), RangeError);
    await throws(
      "non-string title rejects consistently",
      () => validators.assertNonEmptyTitle(null),
      RangeError,
    );
    equal("name guard remains intact", validators.assertNonEmptyName("  Ada  "), "Ada");
  },
  "b1-rename-exported-symbol": async ({ importModule, equal }) => {
    const index = await importModule("src/index.mjs");
    const receipt = await importModule("src/receipt.mjs");
    equal("renamed export formats short ID", index.formatDisplayId(7), "ID-000007");
    equal("renamed export preserves long ID", index.formatDisplayId(1234567), "ID-1234567");
    equal("dependent import resolves", receipt.renderReceiptHeader(42), "Receipt for ID-000042");
  },
  "b1-string-pad-length-bug": async ({ importModule, equal }) => {
    const { padCode } = await importModule("src/codes.mjs");
    equal("pads left", padCode(7, 5), "00007");
    equal("generalizes length", padCode(42, 4), "0042");
    equal("does not truncate long code", padCode(12345, 3), "12345");
    equal("string input remains supported", padCode("A7", 4), "00A7");
  },
  "b2-bulk-op-tenant-bypass": async ({ importModule, equal }) => {
    const store = await importModule("src/item-store.mjs");
    const { bulkArchiveItems } = await importModule("src/bulk-archive.mjs");
    store.seedItem("a-1", "tenant-a");
    store.seedItem("b-1", "tenant-b");
    store.seedItem("a-2", "tenant-a");
    const results = bulkArchiveItems("tenant-a", ["a-1", "missing", "b-1", "a-2"]);
    equal("reports every requested item", results, [
      { id: "a-1", archived: true },
      { id: "missing", archived: false, reason: "NOT_FOUND" },
      { id: "b-1", archived: false, reason: "TENANT_MISMATCH" },
      { id: "a-2", archived: true },
    ]);
    equal(
      "eligible items archive",
      [store.getItem("a-1").status, store.getItem("a-2").status],
      ["ARCHIVED", "ARCHIVED"],
    );
    equal("foreign item remains unchanged", store.getItem("b-1").status, "ACTIVE");
  },
  "b2-concurrent-seat-lost-update": async ({ importModule, equal }) => {
    const inventory = await importModule("src/seat-inventory.mjs");
    inventory.seedEvent("one", 1);
    const first = await Promise.all([
      inventory.bookSeat("one", "alice", async () => await Promise.resolve()),
      inventory.bookSeat("one", "bob", async () => await Promise.resolve()),
    ]);
    equal("one seat produces one winner", first.filter(Boolean).length, 1);
    equal(
      "one-seat state remains consistent",
      {
        available: inventory.getEvent("one").available,
        booked: inventory.getEvent("one").bookedBy.length,
      },
      { available: 0, booked: 1 },
    );
    inventory.seedEvent("two", 2);
    const second = await Promise.all(
      ["a", "b", "c"].map((user) =>
        inventory.bookSeat("two", user, async () => await Promise.resolve()),
      ),
    );
    equal("two seats produce two winners", second.filter(Boolean).length, 2);
    equal(
      "two-seat state remains consistent",
      {
        available: inventory.getEvent("two").available,
        booked: inventory.getEvent("two").bookedBy.length,
      },
      { available: 0, booked: 2 },
    );
  },
  "b2-order-refund-terminal-leak": async ({ importModule, equal, throws }) => {
    const store = await importModule("src/order-store.mjs");
    const { processRefund } = await importModule("src/refund-service.mjs");
    store.createOrder("invalid", 100);
    await throws("invalid amount rejects", () => processRefund("invalid", -5), Error);
    equal("invalid amount leaves order paid", store.getOrder("invalid").status, "PAID");
    store.createOrder("ledger-fail", 100);
    await throws(
      "ledger failure propagates",
      () =>
        processRefund("ledger-fail", 5, async () => {
          throw new Error("ledger unavailable");
        }),
      Error,
    );
    equal("ledger failure leaves order paid", store.getOrder("ledger-fail").status, "PAID");
    store.createOrder("valid", 100);
    equal(
      "successful refund becomes terminal",
      (await processRefund("valid", 10)).status,
      "REFUNDED",
    );
  },
  "b2-record-shape-migration-loss": async ({ importModule, equal, check }) => {
    const { migrateRecordV1toV2 } = await importModule("src/migrate-record.mjs");
    const input = {
      id: "r1",
      name: "Widget",
      createdAt: 100,
      metadata: { tags: ["a"] },
      extension: { color: "blue" },
    };
    const before = structuredClone(input);
    const output = migrateRecordV1toV2(input);
    equal("schema version advances", output.schemaVersion, 2);
    equal(
      "known fields preserved",
      { id: output.id, name: output.name, createdAt: output.createdAt },
      { id: "r1", name: "Widget", createdAt: 100 },
    );
    equal("metadata preserved", output.metadata, input.metadata);
    equal("unknown extension preserved", output.extension, input.extension);
    equal("input is not mutated", input, before);
    check("returns a new record", output !== input, "migration must not return the input object");
  },
  "b2-partial-validation-mutation": async ({ importModule, equal, throws }) => {
    const { applyPatch } = await importModule("src/apply-patch.mjs");
    for (const patch of [null, {}, { status: 42 }, { status: "invalid" }]) {
      const record = { status: "open", owner: "Ada" };
      const before = { ...record };
      await throws(
        `invalid patch ${JSON.stringify(patch)} rejects`,
        () => applyPatch(record, patch),
        Error,
      );
      equal(`invalid patch ${JSON.stringify(patch)} is atomic`, record, before);
    }
    const original = { status: "open", owner: "Ada" };
    const result = applyPatch(original, { status: "closed" });
    equal("valid patch applies status", result.status, "closed");
    equal("valid patch preserves unrelated fields", result.owner, "Ada");
  },
  "b2-derived-aggregate-consistency": async ({ importModule, equal, throws }) => {
    const { addLine } = await importModule("src/cart.mjs");
    const original = { lines: [{ sku: "A", amount: 5 }], total: 5 };
    const before = structuredClone(original);
    const next = addLine(original, { sku: "B", amount: 3 });
    equal("derived total includes every line", next.total, 8);
    equal("returned lines contain old and new", next.lines, [
      { sku: "A", amount: 5 },
      { sku: "B", amount: 3 },
    ]);
    equal("original state remains unchanged", original, before);
    await throws(
      "invalid amount rejects",
      () => addLine(original, { sku: "C", amount: Number.NaN }),
      TypeError,
    );
    equal("invalid add remains atomic", original, before);
  },
  "b2-pending-write-visibility": async ({ importModule, equal }) => {
    const { createCommitStore } = await importModule("src/commit-store.mjs");
    const store = createCommitStore();
    const first = store.begin("first", "one");
    const second = store.begin("second", "two");
    equal("first pending value is hidden", store.read("first"), undefined);
    equal("second pending value is hidden", store.read("second"), undefined);
    store.commit(first);
    equal("committed first value is visible", store.read("first"), "one");
    equal("uncommitted second remains hidden", store.read("second"), undefined);
    store.commit(second);
    equal("second value appears after its commit", store.read("second"), "two");
    const other = createCommitStore();
    equal("stores are independent", other.read("first"), undefined);
  },
};
