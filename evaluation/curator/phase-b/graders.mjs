import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const phaseBGraders = {
  "clamp-number-util": async ({ importModule, equal, throws }) => {
    const module = await importModule("src/number-utils.mjs");
    equal("rounds at requested decimal place", module.roundTo(4.5678, 2), 4.57);
    equal("rounds negative values", module.roundTo(-2.6, 0), -3);
    equal("preserves range API", module.isInRange(5, 1, 10), true);
    equal("clamps numeric strings", module.clampNumber("12", 0, 10), 10);
    equal("uses Number conversion for null", module.clampNumber(null, -2, 2), 0);
    equal("clamps below lower bound", module.clampNumber(-9, -3, 4), -3);
    await throws("rejects non-finite input", () => module.clampNumber("nope", 0, 1), TypeError);
    await throws("rejects reversed bounds", () => module.clampNumber(1, 2, 1), RangeError);
  },
  "duration-carry-fix": async ({ importModule, equal, throws }) => {
    const { addDuration } = await importModule("src/duration.mjs");
    equal(
      "carries into next day",
      addDuration("2026-01-01T23:59:00Z", 2).toISOString(),
      "2026-01-02T00:01:00.000Z",
    );
    equal(
      "carries into next year",
      addDuration("2025-12-31T23:30:00Z", 90).toISOString(),
      "2026-01-01T01:00:00.000Z",
    );
    equal(
      "accepts integer numeric text",
      addDuration("2026-01-01T00:00:00Z", "60").toISOString(),
      "2026-01-01T01:00:00.000Z",
    );
    await throws(
      "rejects fractional duration",
      () => addDuration("2026-01-01T00:00:00Z", 1.5),
      TypeError,
    );
    await throws("rejects invalid start", () => addDuration("not-a-date", 1), RangeError);
  },
  "csv-export-feature": async ({ importModule, equal }) => {
    const { writeReport } = await importModule("src/report-writer.mjs");
    const report = {
      columns: ["name", "note", "value"],
      rows: [
        ["Ada", "a,b", 2],
        ["Bob", 'said "hi"', null],
        ["Cy", "line\nbreak", undefined],
      ],
    };
    equal(
      "formats complete CSV with escaping",
      writeReport(report, "csv"),
      'name,note,value\nAda,"a,b",2\nBob,"said ""hi""",\nCy,"line\nbreak",',
    );
    equal(
      "preserves JSON formatter",
      JSON.parse(writeReport({ columns: ["x"], rows: [[1]] }, "json")),
      { columns: ["x"], rows: [[1]] },
    );
  },
  "pagination-cursor-feature": async ({ importModule, equal, check, throws }) => {
    const { addItem, listItemsPage } = await importModule("src/item-service.mjs");
    for (let index = 1; index <= 6; index += 1) addItem({ name: `item-${index}` });
    const first = listItemsPage(null, 2);
    const second = listItemsPage(first.nextCursor, 2);
    const third = listItemsPage(second.nextCursor, 2);
    equal(
      "first page",
      first.items.map((item) => item.name),
      ["item-1", "item-2"],
    );
    equal(
      "cursor continues without duplication",
      second.items.map((item) => item.name),
      ["item-3", "item-4"],
    );
    equal(
      "final page",
      third.items.map((item) => item.name),
      ["item-5", "item-6"],
    );
    equal("final cursor is null", third.nextCursor, null);
    check(
      "intermediate cursors are opaque strings",
      typeof first.nextCursor === "string" && typeof second.nextCursor === "string",
      "expected string cursors",
    );
    await throws("rejects malformed cursor", () => listItemsPage("not-a-cursor", 2), RangeError);
    await throws("rejects invalid limit", () => listItemsPage(null, 0), RangeError);
  },
  "stale-cache-invalidation-bug": async ({ importModule, equal }) => {
    const { getUserProfile, updateUserProfile } = await importModule(
      "src/user-profile-service.mjs",
    );
    equal("loads initial profile", getUserProfile(1).email, "alice@example.com");
    equal("loads unrelated profile", getUserProfile(2).email, "bob@example.com");
    updateUserProfile(1, { email: "alice+new@example.com" });
    equal("read observes first update", getUserProfile(1).email, "alice+new@example.com");
    updateUserProfile(1, { name: "Alicia" });
    equal("repeated update remains visible", getUserProfile(1).name, "Alicia");
    equal("unrelated cached profile is unchanged", getUserProfile(2).email, "bob@example.com");
  },
  "event-emitter-listener-leak": async ({ importModule, equal }) => {
    const { createEventBus } = await importModule("src/event-bus.mjs");
    const bus = createEventBus();
    const seen = [];
    const first = (value) => seen.push(`a${value}`);
    const second = (value) => seen.push(`b${value}`);
    const stopFirst = bus.on("event", first);
    bus.on("event", second);
    bus.emit("event", 1);
    stopFirst();
    stopFirst();
    bus.emit("event", 2);
    equal("stop removes only its registration and is idempotent", seen, ["a1", "b1", "b2"]);
    bus.off("event", second);
    bus.emit("event", 3);
    equal("off removes the named listener", seen, ["a1", "b1", "b2"]);
    const metrics = await importModule("src/metrics-subscriber.mjs");
    const metricsBus = createEventBus();
    for (let index = 0; index < 4; index += 1) {
      const stop = metrics.startMetricsSubscriber(metricsBus);
      metricsBus.emit("order-placed", { orderId: index });
      stop();
      metricsBus.emit("order-placed", { orderId: `after-${index}` });
    }
    equal("repeated subscriber lifecycle does not leak", metrics.getMetricsCount(), 4);
  },
  "inventory-orientation-task": async ({ importModule, equal, throws }) => {
    const { addItem } = await importModule("src/operations/add-item.mjs");
    const { restockItem } = await importModule("src/operations/restock-item.mjs");
    const { getItem } = await importModule("src/inventory-store.mjs");
    addItem("sku-a", "Widget", 10);
    equal("allows signed adjustment with valid result", restockItem("sku-a", -3).quantity, 7);
    await throws("rejects negative resulting quantity", () => restockItem("sku-a", -8), RangeError);
    equal("rejected adjustment is atomic", getItem("sku-a").quantity, 7);
    await throws("rejects fractional adjustment", () => restockItem("sku-a", 0.5), TypeError);
    equal("positive restock still works", restockItem("sku-a", 5).quantity, 12);
  },
  "backward-compat-date-regression": async ({ importModule, equal, throws }) => {
    const { overlapDays } = await importModule("src/date-range.mjs");
    equal("touching inclusive ranges share one day", overlapDays(1, 5, 5, 10), 1);
    equal("contained overlap is inclusive", overlapDays(2, 10, 4, 6), 3);
    equal("disjoint ranges return zero", overlapDays(1, 2, 4, 5), 0);
    equal("identical single-day ranges", overlapDays(7, 7, 7, 7), 1);
    await throws("rejects reversed ranges", () => overlapDays(2, 1, 3, 4), RangeError);
    await throws("rejects non-integer endpoints", () => overlapDays(1, 2.5, 2, 3), TypeError);
  },
  "past-due-reminder-handling": async ({ importModule, equal, throws }) => {
    const scheduler = await importModule("src/reminder-scheduler.mjs");
    scheduler.scheduleReminder("past", 90, 100);
    scheduler.scheduleReminder("now", 100, 100);
    scheduler.scheduleReminder("future", 120, 100);
    equal(
      "all accepted reminders are scheduled",
      scheduler.listScheduled().map((item) => item.taskId),
      ["past", "now", "future"],
    );
    equal(
      "past and current reminders are due",
      scheduler.dueReminders(100).map((item) => item.taskId),
      ["past", "now"],
    );
    const copy = scheduler.listScheduled();
    copy.length = 0;
    equal("list is a defensive copy", scheduler.listScheduled().length, 3);
    await throws("rejects empty task id", () => scheduler.scheduleReminder("", 1, 2), TypeError);
    await throws(
      "rejects invalid timestamp",
      () => scheduler.scheduleReminder("x", Number.NaN, 2),
      TypeError,
    );
  },
  "report-output-path-boundary": async ({ workspace, importModule, equal, check, throws }) => {
    const { writeReportFile } = await importModule("src/report-writer.mjs");
    const outDir = path.join(workspace, "generated");
    const relativeTarget = writeReportFile(outDir, "nested/report.txt", "relative");
    equal("writes relative contained path", await readFile(relativeTarget, "utf8"), "relative");
    const absoluteRequest = path.join(outDir, "absolute.txt");
    const absoluteTarget = writeReportFile(outDir, absoluteRequest, "absolute");
    equal(
      "accepts safe absolute contained path",
      path.resolve(absoluteTarget),
      path.resolve(absoluteRequest),
    );
    equal("writes safe absolute content", await readFile(absoluteTarget, "utf8"), "absolute");
    const escaped = path.join(workspace, "escaped.txt");
    await throws(
      "rejects parent traversal",
      () => writeReportFile(outDir, "../escaped.txt", "bad"),
      RangeError,
    );
    check("traversal did not write", !(await exists(escaped)), "escaped file must not exist");
    const sibling = `${outDir}-sibling`;
    await throws(
      "rejects sibling prefix path",
      () => writeReportFile(outDir, path.join(sibling, "bad.txt"), "bad"),
      RangeError,
    );
  },
  "idempotency-key-race": async ({ importModule, equal }) => {
    const store = await importModule("src/idempotency-store.mjs");
    const results = await Promise.all(Array.from({ length: 8 }, () => store.reserveKey("same")));
    equal("exactly one concurrent reservation wins", results.filter(Boolean).length, 1);
    equal(
      "different keys proceed independently",
      await Promise.all([store.reserveKey("a"), store.reserveKey("b")]),
      [true, true],
    );
    store.releaseKey("same");
    equal("release permits later reservation", await store.reserveKey("same"), true);
    store.markRecorded("recorded");
    equal("persistent audit record blocks reservation", await store.reserveKey("recorded"), false);
  },
  "webhook-retry-terminal-state": async ({ importModule, equal }) => {
    const { deliverWebhook } = await importModule("src/webhook-delivery.mjs");
    for (const status of [400, 401, 403, 404, 410, 418]) {
      let calls = 0;
      const result = await deliverWebhook({ id: status }, async () => {
        calls += 1;
        return { status };
      });
      equal(
        `terminal ${status} is rejected once`,
        { result, calls },
        { result: { status: "REJECTED", attempts: 1 }, calls: 1 },
      );
    }
    let recoveryCalls = 0;
    const recovered = await deliverWebhook({}, async () => ({
      status: ++recoveryCalls === 3 ? 204 : 503,
    }));
    equal("retryable response can recover", recovered, { status: "DELIVERED", attempts: 3 });
    let exhaustedCalls = 0;
    const exhausted = await deliverWebhook({}, async () => {
      exhaustedCalls += 1;
      return { status: 429 };
    });
    equal(
      "retryable response exhausts at five",
      { exhausted, exhaustedCalls },
      { exhausted: { status: "RETRY_EXHAUSTED", attempts: 5 }, exhaustedCalls: 5 },
    );
  },
};

async function exists(target) {
  return await access(target).then(
    () => true,
    () => false,
  );
}
