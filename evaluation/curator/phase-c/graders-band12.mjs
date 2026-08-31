// Phase C Band 1 and Band 2 behavioral graders.
//
// Band 1 prompts quote the existing RangeError guards verbatim, so requiring RangeError there is
// publicly justified. Band 2 prompts describe *ordering* contracts ("reject before mutating",
// "only after the ledger call succeeds") without naming an error class, so those graders accept any
// rejection type and instead observe the intermediate state. See GRADER_CONTRACT_AUDIT.md.

const REJECTION = [TypeError, RangeError];

export const phaseCBand12Graders = {
  // Prompt: add a triangle case, do not change existing kinds or how unknown kinds are rejected
  // (the demo output shows the existing rejection is a RangeError).
  "b1-extend-exhaustive-union": async ({ importModule, equal, check, throws }) => {
    const { computeArea } = await importModule("src/shape-area.mjs");
    equal("square unchanged", computeArea({ kind: "square", side: 5 }), 25);
    equal("rectangle unchanged", computeArea({ kind: "rectangle", width: 3, height: 6 }), 18);
    equal("circle unchanged", computeArea({ kind: "circle", radius: 2 }), Math.PI * 4);

    // The triangle formula must generalize, not memorize the demo's arguments.
    let agrees = true;
    for (let base = 0; base <= 9; base += 1) {
      for (const height of [0, 1, 2.5, 4, 7, 11.25]) {
        if (computeArea({ kind: "triangle", base, height }) !== 0.5 * base * height) agrees = false;
      }
    }
    check(
      "triangle area generalizes across bases and heights",
      agrees,
      "triangle area diverged from 0.5 * base * height",
    );
    equal("triangle area sample", computeArea({ kind: "triangle", base: 7, height: 4 }), 14);

    for (const kind of ["hexagon", "trapezoid", "", undefined]) {
      await throws(
        `unknown kind ${String(kind)} still rejects`,
        () => computeArea({ kind }),
        RangeError,
      );
    }
  },

  // Prompt: "throw the same RangeError on an empty array" and reuse sumArray.
  "b1-mirror-pure-utility-fn": async ({ importModule, equal, check, throws }) => {
    const stats = await importModule("src/stats.mjs");
    equal("average of positive values", stats.averageArray([2, 4, 9]), 5);
    equal("average of signed values", stats.averageArray([-4, 2, 8]), 2);
    equal("average uses actual input length", stats.averageArray([10, 20]), 15);
    equal("single-element average", stats.averageArray([42]), 42);
    equal("sum remains unchanged", stats.sumArray([2, 4, 9]), 15);
    equal("sum of a single element remains unchanged", stats.sumArray([5]), 5);

    let agrees = true;
    for (const values of [[1], [1, 2], [1, 2, 3, 4], [-1, -2, -3], [0, 0, 0], [1.5, 2.5]]) {
      const expected = values.reduce((total, value) => total + value, 0) / values.length;
      if (stats.averageArray(values) !== expected) agrees = false;
    }
    check("average generalizes across inputs", agrees, "average diverged from sum / length");

    await throws("empty average mirrors sum guard", () => stats.averageArray([]), RangeError);
    await throws("empty sum guard is preserved", () => stats.sumArray([]), RangeError);
  },

  // Prompt: mirror assertNonEmptyName's contract, which rejects with RangeError.
  "b1-mirror-sibling-guard-clause": async ({ importModule, equal, throws }) => {
    const validators = await importModule("src/validators.mjs");
    equal("title is trimmed", validators.assertNonEmptyTitle("  Ship it  "), "Ship it");
    equal(
      "an already-trimmed title is returned as is",
      validators.assertNonEmptyTitle("Ship"),
      "Ship",
    );
    equal("interior whitespace is preserved", validators.assertNonEmptyTitle("  a  b  "), "a  b");
    for (const bad of ["", "   ", "\t\n", null, undefined, 42, {}]) {
      await throws(
        `title ${JSON.stringify(bad) ?? String(bad)} rejects`,
        () => validators.assertNonEmptyTitle(bad),
        RangeError,
      );
    }
    equal("name guard remains intact", validators.assertNonEmptyName("  Ada  "), "Ada");
    await throws("name guard still rejects", () => validators.assertNonEmptyName("  "), RangeError);
  },

  // Prompt: rename the export so both consumers resolve; do not change what the function does.
  "b1-rename-exported-symbol": async ({ importModule, equal, check }) => {
    const index = await importModule("src/index.mjs");
    const receipt = await importModule("src/receipt.mjs");
    const idUtils = await importModule("src/id-utils.mjs");
    equal("renamed export formats short ID", index.formatDisplayId(7), "ID-000007");
    equal("renamed export preserves long ID", index.formatDisplayId(1234567), "ID-1234567");
    equal("exact-width ID is unchanged", index.formatDisplayId(123456), "ID-123456");
    equal("dependent import resolves", receipt.renderReceiptHeader(42), "Receipt for ID-000042");
    check(
      "the owning module exports the new name",
      typeof idUtils.formatDisplayId === "function",
      "src/id-utils.mjs must export formatDisplayId",
    );

    let agrees = true;
    for (const raw of [0, 1, 99, 100000, 999999, 1000000, "AB"]) {
      if (index.formatDisplayId(raw) !== `ID-${String(raw).padStart(6, "0")}`) agrees = false;
    }
    check(
      "behavior is unchanged by the rename",
      agrees,
      "formatting diverged from the original implementation",
    );
  },

  // Prompt: pad on the left; a code already at least `length` long is returned unchanged.
  "b1-string-pad-length-bug": async ({ importModule, equal, check }) => {
    const { padCode } = await importModule("src/codes.mjs");
    equal("pads left", padCode(7, 5), "00007");
    equal("generalizes length", padCode(42, 4), "0042");
    equal("does not truncate long code", padCode(12345, 3), "12345");
    equal("exact length is unchanged", padCode(12345, 5), "12345");
    equal("string input remains supported", padCode("A7", 4), "00A7");
    equal("zero length is unchanged", padCode(9, 0), "9");

    let agrees = true;
    for (const code of [0, 7, 42, 12345, "A7", "abc"]) {
      for (let length = 0; length <= 8; length += 1) {
        if (padCode(code, length) !== String(code).padStart(length, "0")) agrees = false;
      }
    }
    check("left padding generalizes", agrees, "padding diverged from padStart semantics");
  },

  // Prompt: "A missing or foreign item must not be mutated" -- checked by reading the store back,
  // not only by reading the returned report.
  "b2-bulk-op-tenant-bypass": async ({ importModule, equal, check }) => {
    const store = await importModule("src/item-store.mjs");
    const { bulkArchiveItems } = await importModule("src/bulk-archive.mjs");
    store.seedItem("a-1", "tenant-a");
    store.seedItem("b-1", "tenant-b");
    store.seedItem("a-2", "tenant-a");
    store.seedItem("c-1", "tenant-c");

    const results = bulkArchiveItems("tenant-a", [
      "a-1",
      "missing",
      "b-1",
      "a-2",
      "c-1",
      "also-missing",
    ]);
    equal("reports every requested item in input order", results, [
      { id: "a-1", archived: true },
      { id: "missing", archived: false, reason: "NOT_FOUND" },
      { id: "b-1", archived: false, reason: "TENANT_MISMATCH" },
      { id: "a-2", archived: true },
      { id: "c-1", archived: false, reason: "TENANT_MISMATCH" },
      { id: "also-missing", archived: false, reason: "NOT_FOUND" },
    ]);
    equal(
      "eligible items archive",
      [store.getItem("a-1").status, store.getItem("a-2").status],
      ["ARCHIVED", "ARCHIVED"],
    );
    equal("foreign item remains unchanged", store.getItem("b-1").status, "ACTIVE");
    equal("second foreign item remains unchanged", store.getItem("c-1").status, "ACTIVE");

    // An unknown id must stay unknown: reporting NOT_FOUND may not create a record for it.
    for (const id of ["missing", "also-missing"]) {
      check(
        `unknown id ${id} is not created in the store`,
        store.getItem(id) === null || store.getItem(id) === undefined,
        `expected ${id} to remain absent, found ${JSON.stringify(store.getItem(id))}`,
      );
    }

    // The behavior must generalize to another tenant rather than special-casing one.
    const foreign = bulkArchiveItems("tenant-b", ["b-1", "a-1"]);
    equal("another tenant archives only its own item", foreign, [
      { id: "b-1", archived: true },
      { id: "a-1", archived: false, reason: "TENANT_MISMATCH" },
    ]);
    equal("the other tenant's item is now archived", store.getItem("b-1").status, "ARCHIVED");
    equal(
      "an already-archived foreign item is not re-touched",
      store.getItem("a-1").status,
      "ARCHIVED",
    );
    equal("an empty batch is accepted", bulkArchiveItems("tenant-a", []), []);
  },

  // Prompt: never more successful bookings than available seats, and available/bookedBy must agree.
  "b2-concurrent-seat-lost-update": async ({ importModule, equal, check }) => {
    const inventory = await importModule("src/seat-inventory.mjs");
    const yielding = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    for (const [seats, contenders] of [
      [1, 2],
      [2, 3],
      [3, 8],
      [5, 5],
      [0, 4],
    ]) {
      const id = `event-${seats}-${contenders}`;
      inventory.seedEvent(id, seats);
      const outcomes = await Promise.all(
        Array.from({ length: contenders }, (_, index) =>
          inventory.bookSeat(id, `user-${index}`, yielding),
        ),
      );
      const winners = outcomes.filter(Boolean).length;
      const event = inventory.getEvent(id);
      equal(
        `${seats} seats / ${contenders} contenders produces the right winner count`,
        winners,
        Math.min(seats, contenders),
      );
      equal(
        `${seats} seats / ${contenders} contenders leaves consistent state`,
        { available: event.available, booked: event.bookedBy.length },
        {
          available: seats - Math.min(seats, contenders),
          booked: Math.min(seats, contenders),
        },
      );
      check(
        `${seats} seats / ${contenders} contenders records distinct users`,
        new Set(event.bookedBy).size === event.bookedBy.length,
        `bookedBy contains duplicates: ${JSON.stringify(event.bookedBy)}`,
      );
    }

    // Concurrent bookings across different events must not interfere.
    inventory.seedEvent("left", 1);
    inventory.seedEvent("right", 1);
    const mixed = await Promise.all([
      inventory.bookSeat("left", "a", yielding),
      inventory.bookSeat("right", "b", yielding),
      inventory.bookSeat("left", "c", yielding),
      inventory.bookSeat("right", "d", yielding),
    ]);
    equal("independent events each seat exactly one winner", mixed.filter(Boolean).length, 2);
    equal(
      "unknown events return false",
      await inventory.bookSeat("no-such-event", "x", yielding),
      false,
    );

    const started = Date.now();
    inventory.seedEvent("timing", 1);
    await Promise.all([
      inventory.bookSeat("timing", "a", yielding),
      inventory.bookSeat("timing", "b", yielding),
    ]);
    check(
      "synchronization does not rely on wall-clock delays",
      Date.now() - started < 1_000,
      "booking took over a second",
    );
  },

  // Prompt: "may set an order to REFUNDED only after the ledger call succeeds". The injected ledger
  // hook is the observation point: at the moment it runs, the order must not yet be terminal.
  "b2-order-refund-terminal-leak": async ({ importModule, equal, check, throws }) => {
    const store = await importModule("src/order-store.mjs");
    const { processRefund } = await importModule("src/refund-service.mjs");

    // Statuses observed from inside the ledger call, for both successful and failing ledgers. The
    // injected hook mirrors the real ledger's return shape so an implementation that inspects the
    // ledger receipt is not penalised for doing so.
    const observed = [];
    const observingLedger = (orderId) => async (id, amount) => {
      observed.push({ orderId, status: store.getOrder(orderId)?.status ?? null });
      return { recorded: true, orderId: id, amount };
    };
    const failingLedger = (orderId) => async () => {
      observed.push({ orderId, status: store.getOrder(orderId)?.status ?? null });
      throw new Error("ledger unavailable");
    };

    for (const [id, total] of [
      ["ok-1", 100],
      ["ok-2", 60],
      ["ok-3", 25],
    ]) {
      store.createOrder(id, total);
      const result = await processRefund(id, 5, observingLedger(id));
      equal(`successful refund ${id} becomes terminal`, result.status, "REFUNDED");
      equal(`successful refund ${id} persists`, store.getOrder(id).status, "REFUNDED");
    }
    for (const [id, total] of [
      ["fail-1", 100],
      ["fail-2", 80],
    ]) {
      store.createOrder(id, total);
      await throws(
        `ledger failure ${id} propagates`,
        () => processRefund(id, 4, failingLedger(id)),
        Error,
      );
      equal(`ledger failure ${id} leaves order paid`, store.getOrder(id).status, "PAID");
    }

    const leaked = observed.filter((entry) => entry.status !== "PAID");
    check(
      "the terminal state is never published before the ledger accepts it",
      leaked.length === 0,
      `orders already terminal when the ledger ran: ${JSON.stringify(leaked)}`,
    );
    check(
      "the ledger observation actually ran",
      observed.length === 5,
      `expected 5 ledger observations, saw ${observed.length}`,
    );

    // Invalid amounts are exercised against the default ledger, because the prompt leaves it open
    // whether the service or the ledger owns amount validation -- only the outcome is contractual.
    // The set is limited to non-positive amounts, which is the notion of "invalid" the public
    // repository already encodes; requiring NaN to reject would be a requirement the prompt and the
    // visible ledger never state.
    store.createOrder("invalid", 100);
    for (const amount of [-5, 0, -0.01, null]) {
      await throws(
        `invalid amount ${String(amount)} rejects`,
        () => processRefund("invalid", amount),
        Error,
      );
      equal(
        `invalid amount ${String(amount)} leaves order paid`,
        store.getOrder("invalid").status,
        "PAID",
      );
    }
    await throws("missing order rejects", () => processRefund("no-such-order", 5), Error);
    equal(
      "a valid refund still succeeds after rejections",
      (await processRefund("invalid", 10)).status,
      "REFUNDED",
    );
  },

  // Prompt: "It must not mutate the input" and extensions must survive. Mutation is observed while
  // the call runs, so temporarily writing to the caller's record and restoring it is not a pass.
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

    // "Must not mutate the input" is a statement about the whole call, not only about the state
    // afterwards. A frozen input makes any write observable, and an implementation that never
    // writes cannot tell the difference. Reading, spreading and structuredClone all still work.
    const frozen = Object.freeze(structuredClone(input));
    let frozenError = null;
    let frozenOutput;
    try {
      frozenOutput = migrateRecordV1toV2(frozen);
    } catch (error) {
      frozenError = error;
    }
    check(
      "the input is never written to, even transiently",
      frozenError === null,
      frozenError
        ? `migrating a non-writable input failed with ${frozenError.constructor?.name}: ${frozenError.message}`
        : "no write reached the input",
    );
    if (frozenError === null) {
      equal("a non-writable input still migrates", frozenOutput.schemaVersion, 2);
      equal("a non-writable input keeps its extensions", frozenOutput.extension, input.extension);
    }

    // Arbitrary unknown fields must survive, and a record that already carries extensions must not
    // be rejected for its shape.
    const wide = {
      id: "r2",
      name: "N",
      createdAt: 1,
      alpha: 1,
      beta: [1, 2],
      gamma: { deep: true },
      schemaVersion: 1,
    };
    const wideBefore = structuredClone(wide);
    const wideOutput = migrateRecordV1toV2(wide);
    equal(
      "unknown fields survive",
      { alpha: wideOutput.alpha, beta: wideOutput.beta, gamma: wideOutput.gamma },
      { alpha: 1, beta: [1, 2], gamma: { deep: true } },
    );
    equal("schema version is advanced from an existing one", wideOutput.schemaVersion, 2);
    equal("the wide input is unchanged", wide, wideBefore);
  },

  // Prompt: an invalid patch "must throw without changing any property of record". Observed while
  // the call runs, so mutate-then-restore is not a pass. No error class is named.
  "b2-partial-validation-mutation": async ({ importModule, equal, check, throws }) => {
    const { applyPatch } = await importModule("src/apply-patch.mjs");

    for (const patch of [
      null,
      undefined,
      {},
      { status: 42 },
      { status: "invalid" },
      { status: null },
      { owner: "x" },
    ]) {
      const record = { status: "open", owner: "Ada", tags: ["a"] };
      const before = structuredClone(record);
      const writes = [];
      const tracked = new Proxy(record, {
        set(target, property, value, receiver) {
          writes.push({ kind: "set", property: String(property), value });
          return Reflect.set(target, property, value, receiver);
        },
        deleteProperty(target, property) {
          writes.push({ kind: "delete", property: String(property) });
          return Reflect.deleteProperty(target, property);
        },
      });
      const label = JSON.stringify(patch) ?? String(patch);
      await throws(`invalid patch ${label} rejects`, () => applyPatch(tracked, patch), REJECTION);
      equal(`invalid patch ${label} leaves the record equal`, record, before);
      check(
        `invalid patch ${label} never writes to the record`,
        writes.length === 0,
        `observed ${writes.length} write(s) before rejection: ${JSON.stringify(writes.slice(0, 4))}`,
      );
    }

    for (const status of ["open", "closed"]) {
      const original = { status: status === "open" ? "closed" : "open", owner: "Ada", tags: ["a"] };
      const result = applyPatch(original, { status });
      equal(`valid patch applies status ${status}`, result.status, status);
      equal(
        `valid patch ${status} preserves unrelated fields`,
        { owner: result.owner, tags: result.tags },
        { owner: "Ada", tags: ["a"] },
      );
    }
  },

  // Prompt: total equals the sum of every line amount, invalid input is rejected without mutating
  // the original state. No error class is named, so any rejection type is accepted.
  "b2-derived-aggregate-consistency": async ({ importModule, equal, check, throws }) => {
    const { addLine } = await importModule("src/cart.mjs");

    // Totals must stay consistent as lines accumulate, not just for the first addition.
    let state = { lines: [], total: 0 };
    const amounts = [5, 3, -2, 10.5, 0, 7];
    for (const amount of amounts) {
      state = addLine(state, { sku: `s${amount}`, amount });
    }
    equal(
      "derived total sums every line",
      state.total,
      amounts.reduce((sum, value) => sum + value, 0),
    );
    equal(
      "every line is retained in order",
      state.lines.map((line) => line.amount),
      amounts,
    );

    const original = { lines: [{ sku: "A", amount: 5 }], total: 5 };
    const before = structuredClone(original);
    const next = addLine(original, { sku: "B", amount: 3 });
    equal("derived total includes every line", next.total, 8);
    equal("returned lines contain old and new", next.lines, [
      { sku: "A", amount: 5 },
      { sku: "B", amount: 3 },
    ]);
    equal("original state remains unchanged", original, before);
    check(
      "the added line is a copy",
      next.lines[1] !== undefined && next.lines.at(-1).sku === "B",
      "expected the new line to be present",
    );

    // A stale `total` on the input must not be trusted: the returned total is derived from the lines.
    const stale = { lines: [{ sku: "A", amount: 5 }], total: 999 };
    equal("a stale input total is recomputed", addLine(stale, { sku: "B", amount: 3 }).total, 8);

    for (const amount of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "3",
      null,
      undefined,
    ]) {
      const target = { lines: [{ sku: "A", amount: 5 }], total: 5 };
      const snapshot = structuredClone(target);
      await throws(
        `invalid amount ${String(amount)} rejects`,
        () => addLine(target, { sku: "C", amount }),
        REJECTION,
      );
      equal(`invalid amount ${String(amount)} remains atomic`, target, snapshot);
    }
  },

  // Prompt: a pending transaction must not change what read returns; commit publishes atomically;
  // committing one transaction must not publish another.
  "b2-pending-write-visibility": async ({ importModule, equal, check }) => {
    const { createCommitStore } = await importModule("src/commit-store.mjs");
    const store = createCommitStore();

    const first = store.begin("first", "one");
    const second = store.begin("second", "two");
    const third = store.begin("third", "three");
    equal("first pending value is hidden", store.read("first"), undefined);
    equal("second pending value is hidden", store.read("second"), undefined);
    equal("third pending value is hidden", store.read("third"), undefined);

    store.commit(second);
    equal("committed second value is visible", store.read("second"), "two");
    equal("uncommitted first remains hidden", store.read("first"), undefined);
    equal("uncommitted third remains hidden", store.read("third"), undefined);

    store.commit(first);
    equal("committed first value is visible", store.read("first"), "one");
    equal("third still hidden after two commits", store.read("third"), undefined);
    store.commit(third);
    equal("third value appears after its commit", store.read("third"), "three");

    // Overwriting an existing key follows the same rule.
    const overwrite = store.begin("first", "one-updated");
    equal("a pending overwrite does not change the visible value", store.read("first"), "one");
    store.commit(overwrite);
    equal("the overwrite is visible after commit", store.read("first"), "one-updated");

    const other = createCommitStore();
    equal("stores are independent", other.read("first"), undefined);
    const otherTx = other.begin("first", "other-value");
    equal("a second store's pending write is hidden", other.read("first"), undefined);
    equal("the first store is unaffected by another store", store.read("first"), "one-updated");
    other.commit(otherTx);
    equal("the second store commits independently", other.read("first"), "other-value");
    equal("the first store keeps its own value", store.read("first"), "one-updated");
    check(
      "reading an unknown key yields undefined",
      store.read("never-written") === undefined,
      "expected undefined for an unknown key",
    );
  },
};
