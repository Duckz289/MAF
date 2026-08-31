import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Phase B behavioral graders.
//
// Every assertion below is derived from the task's public prompt. Where the prompt names an error
// class the grader requires it; where the prompt only says "reject", the grader accepts any of the
// error classes a reasonable implementation would choose. See GRADER_CONTRACT_AUDIT.md.

const REJECTION = [TypeError, RangeError];

export const phaseBGraders = {
  // Prompt names TypeError for non-finite conversions and RangeError for min > max, and states that
  // all three arguments are converted with Number(...).
  "clamp-number-util": async ({ importModule, equal, check, throws }) => {
    const module = await importModule("src/number-utils.mjs");
    equal("rounds at requested decimal place", module.roundTo(4.5678, 2), 4.57);
    equal("rounds at a different decimal place", module.roundTo(1.23456, 3), 1.235);
    equal("rounds negative values", module.roundTo(-2.6, 0), -3);
    equal("preserves range API", module.isInRange(5, 1, 10), true);
    equal("preserves range API rejection", module.isInRange(11, 1, 10), false);

    equal("clamps numeric strings", module.clampNumber("12", 0, 10), 10);
    equal("uses Number conversion for null", module.clampNumber(null, -2, 2), 0);
    equal("converts string bounds", module.clampNumber(5, "0", "3"), 3);
    // The prompt names JavaScript's Number(...) conversion explicitly, so the conversion's own
    // behavior is part of the contract and a different parser is not a substitute for it.
    equal("uses Number conversion for booleans", module.clampNumber(true, 0, 5), 1);
    equal("uses Number conversion for false", module.clampNumber(false, -5, 5), 0);
    equal("uses Number conversion for the empty string", module.clampNumber("", -5, 5), 0);
    equal("uses Number conversion for whitespace", module.clampNumber("  ", -5, 5), 0);
    equal("uses Number conversion for hex text", module.clampNumber("0x10", 0, 32), 16);
    await throws(
      "trailing-garbage numerals are not partially parsed",
      () => module.clampNumber("12abc", 0, 100),
      TypeError,
    );
    equal("clamps below lower bound", module.clampNumber(-9, -3, 4), -3);
    equal("returns contained values untouched", module.clampNumber(2, -3, 4), 2);
    equal("inclusive at the lower bound", module.clampNumber(-3, -3, 4), -3);
    equal("inclusive at the upper bound", module.clampNumber(4, -3, 4), 4);

    // Property sweep: clamping must equal min(max(value, min), max) for arbitrary finite inputs.
    let clampAgrees = true;
    for (let value = -6; value <= 6; value += 1) {
      for (const [low, high] of [
        [-3, 3],
        [0, 0],
        [-5, -1],
        [2, 6],
      ]) {
        if (module.clampNumber(value, low, high) !== Math.min(high, Math.max(low, value))) {
          clampAgrees = false;
        }
      }
    }
    check("clamping generalizes across values and bounds", clampAgrees, "clamp result diverged");

    // "reject non-finite converted values" covers every converted argument, not only the first.
    const nonFinite = ["nope", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, {}];
    for (const bad of nonFinite) {
      const label = String(typeof bad === "object" ? "object" : bad);
      await throws(
        `rejects non-finite value (${label})`,
        () => module.clampNumber(bad, 0, 1),
        TypeError,
      );
      await throws(
        `rejects non-finite min (${label})`,
        () => module.clampNumber(1, bad, 10),
        TypeError,
      );
      await throws(
        `rejects non-finite max (${label})`,
        () => module.clampNumber(1, 0, bad),
        TypeError,
      );
    }
    await throws("rejects reversed bounds", () => module.clampNumber(1, 2, 1), RangeError);
    await throws(
      "rejects reversed bounds after conversion",
      () => module.clampNumber(1, "5", "4"),
      RangeError,
    );
  },

  // Prompt names RangeError for an invalid start and TypeError for negative, fractional or
  // non-numeric durations, and requires carry through hours, days, months and years.
  "duration-carry-fix": async ({ importModule, equal, check, throws }) => {
    const { addDuration } = await importModule("src/duration.mjs");
    const iso = (start, minutes) => addDuration(start, minutes).toISOString();
    equal(
      "carries into the next hour",
      iso("2026-01-01T10:30:00Z", 45),
      "2026-01-01T11:15:00.000Z",
    );
    equal("carries into next day", iso("2026-01-01T23:59:00Z", 2), "2026-01-02T00:01:00.000Z");
    equal("carries into next month", iso("2026-01-31T23:30:00Z", 60), "2026-02-01T00:30:00.000Z");
    equal("carries into next year", iso("2025-12-31T23:30:00Z", 90), "2026-01-01T01:00:00.000Z");
    equal(
      "carries across many days",
      iso("2026-03-01T00:00:00Z", 60 * 24 * 40),
      "2026-04-10T00:00:00.000Z",
    );
    equal("zero duration is identity", iso("2026-05-05T05:05:00Z", 0), "2026-05-05T05:05:00.000Z");
    equal(
      "accepts integer numeric text",
      iso("2026-01-01T00:00:00Z", "60"),
      "2026-01-01T01:00:00.000Z",
    );
    equal(
      "accepts a Date-like start",
      iso(new Date("2026-01-01T00:00:00Z"), 30),
      "2026-01-01T00:30:00.000Z",
    );

    // Property sweep against plain epoch arithmetic.
    let carryAgrees = true;
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (const minutes of [1, 7, 59, 60, 61, 1440, 1441, 100_000]) {
      const actual = addDuration("2026-01-01T00:00:00Z", minutes).getTime();
      if (actual !== base + minutes * 60_000) carryAgrees = false;
    }
    check(
      "minute addition matches epoch arithmetic",
      carryAgrees,
      "carry diverged from epoch arithmetic",
    );

    check(
      "returns a Date",
      addDuration("2026-01-01T00:00:00Z", 1) instanceof Date,
      "expected a Date",
    );
    await throws(
      "rejects fractional duration",
      () => addDuration("2026-01-01T00:00:00Z", 1.5),
      TypeError,
    );
    await throws(
      "rejects negative duration",
      () => addDuration("2026-01-01T00:00:00Z", -1),
      TypeError,
    );
    await throws(
      "rejects non-numeric duration",
      () => addDuration("2026-01-01T00:00:00Z", "soon"),
      TypeError,
    );
    await throws("rejects invalid start", () => addDuration("not-a-date", 1), RangeError);
    await throws(
      "rejects another invalid start",
      () => addDuration("2026-13-45T99:99:99Z", 1),
      RangeError,
    );
  },

  // Prompt fully specifies the CSV dialect, so every clause is checked directly.
  "csv-export-feature": async ({ importModule, equal, throws }) => {
    const { writeReport } = await importModule("src/report-writer.mjs");
    const report = {
      columns: ["name", "note", "value"],
      rows: [
        ["Ada", "a,b", 2],
        ["Bob", 'said "hi"', null],
        ["Cy", "line\nbreak", undefined],
        ["Dee", "carriage\rreturn", 0],
        ["Eve", "", false],
      ],
    };
    equal(
      "formats complete CSV with escaping",
      writeReport(report, "csv"),
      "name,note,value\n" +
        'Ada,"a,b",2\n' +
        'Bob,"said ""hi""",\n' +
        'Cy,"line\nbreak",\n' +
        'Dee,"carriage\rreturn",0\n' +
        "Eve,,false",
    );
    equal(
      "quotes header fields that need quoting",
      writeReport({ columns: ["a,b", 'c"d', "plain"], rows: [] }, "csv"),
      '"a,b","c""d",plain',
    );
    equal(
      "preserves row order",
      writeReport({ columns: ["n"], rows: [["3"], ["1"], ["2"]] }, "csv"),
      "n\n3\n1\n2",
    );
    equal(
      "emits no trailing newline",
      writeReport({ columns: ["n"], rows: [["x"]] }, "csv").endsWith("\n"),
      false,
    );
    equal(
      "preserves JSON formatter",
      JSON.parse(writeReport({ columns: ["x"], rows: [[1]] }, "json")),
      { columns: ["x"], rows: [[1]] },
    );
    const registry = await importModule("src/formatters/registry.mjs");
    registry.registerFormatter("probe", () => "probe-output");
    equal(
      "formatter registry still accepts registrations",
      writeReport(report, "probe"),
      "probe-output",
    );
    await throws("unknown format still rejects", () => writeReport(report, "nope"), Error);
  },

  // Prompt names RangeError for malformed/stale cursors and for limits outside 1-100.
  "pagination-cursor-feature": async ({ importModule, equal, check, throws }) => {
    const { addItem, listItemsPage } = await importModule("src/item-service.mjs");
    for (let index = 1; index <= 7; index += 1) addItem({ name: `item-${index}` });

    // Walk the whole collection with a limit that does not divide it evenly: no duplicates, no
    // skips, and a null cursor exactly once at the end.
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = listItemsPage(cursor, 3);
      seen.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 10) break;
    } while (cursor !== null);
    equal("cursor walk visits every item exactly once in order", seen, [
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "item-5",
      "item-6",
      "item-7",
    ]);
    equal("cursor walk terminates on a null cursor", cursor, null);
    equal("cursor walk uses the expected number of pages", pages, 3);

    const first = listItemsPage(null, 2);
    const second = listItemsPage(first.nextCursor, 2);
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
    check(
      "intermediate cursors are opaque strings",
      typeof first.nextCursor === "string" && typeof second.nextCursor === "string",
      "expected string cursors",
    );
    equal(
      "a repeated cursor is idempotent",
      listItemsPage(first.nextCursor, 2).items.map((i) => i.name),
      ["item-3", "item-4"],
    );

    // Cursors are opaque, so staleness is probed without assuming an encoding. Every string derived
    // from a real cursor must either be rejected or resolve to a genuine continuation; silently
    // restarting at the first page is the failure this covers. A cursor always means "after some
    // item", so no accepted cursor may ever return the collection's first item.
    const validCursor = first.nextCursor;
    const mutations = new Set();
    for (let index = 0; index < validCursor.length; index += 1) {
      for (const character of "0123456789abcdefXYZ-_") {
        if (validCursor[index] !== character) {
          mutations.add(validCursor.slice(0, index) + character + validCursor.slice(index + 1));
        }
      }
    }
    mutations.add(validCursor.slice(0, -1));
    mutations.add(`${validCursor}0`);
    mutations.add(`${validCursor}999999`);
    mutations.add(validCursor.toUpperCase());
    mutations.delete(validCursor);
    const restarts = [];
    for (const mutated of mutations) {
      try {
        const page = listItemsPage(mutated, 2);
        if (page.items[0]?.name === "item-1") restarts.push(mutated);
      } catch (error) {
        if (!(error instanceof RangeError))
          restarts.push(`${mutated} (${error?.constructor?.name})`);
      }
    }
    check(
      "an unresolvable cursor is rejected rather than silently restarting",
      restarts.length === 0,
      `cursors that restarted at the first page or threw the wrong type: ${restarts.slice(0, 5).join(", ")}`,
    );
    check(
      "the cursor probe explored several variants",
      mutations.size >= 10,
      `only ${mutations.size} cursor variants were probed`,
    );
    await throws("rejects malformed cursor", () => listItemsPage("not-a-cursor", 2), RangeError);
    await throws("rejects a non-string cursor", () => listItemsPage(42, 2), RangeError);
    for (const limit of [0, -1, 101, 2.5, "3", Number.NaN]) {
      await throws(
        `rejects invalid limit ${String(limit)}`,
        () => listItemsPage(null, limit),
        RangeError,
      );
    }
    equal("accepts the maximum limit", listItemsPage(null, 100).items.length, 7);
  },

  // Prompt: "every later read for that user observes the update", for any user, while other users'
  // cached profiles stay untouched.
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

    // The same guarantee must hold for a different user, so a per-id special case cannot satisfy it.
    updateUserProfile(2, { email: "bob+new@example.com" });
    equal("update generalizes to another user", getUserProfile(2).email, "bob+new@example.com");
    updateUserProfile(2, { name: "Bobby" });
    equal("repeated update generalizes", getUserProfile(2).name, "Bobby");
    equal(
      "first user is unaffected by the second user's update",
      getUserProfile(1).email,
      "alice+new@example.com",
    );
    equal(
      "earlier fields survive a later partial update",
      getUserProfile(2).email,
      "bob+new@example.com",
    );
  },

  // Prompt: stop functions are idempotent and remove only their own registration; off removes the
  // named listener; repeated subscriber lifecycles neither accumulate nor remove unrelated listeners.
  "event-emitter-listener-leak": async ({ importModule, equal }) => {
    const { createEventBus } = await importModule("src/event-bus.mjs");
    const bus = createEventBus();
    const seen = [];
    const first = (value) => seen.push(`a${value}`);
    const second = (value) => seen.push(`b${value}`);
    const third = (value) => seen.push(`c${value}`);
    const stopFirst = bus.on("event", first);
    bus.on("event", second);
    bus.on("event", third);
    bus.emit("event", 1);
    stopFirst();
    stopFirst();
    bus.emit("event", 2);
    equal("stop removes only its registration and is idempotent", seen, [
      "a1",
      "b1",
      "c1",
      "b2",
      "c2",
    ]);

    // off must remove the named listener and leave the event's other listeners registered.
    bus.off("event", second);
    bus.emit("event", 3);
    equal("off removes only the named listener", seen, ["a1", "b1", "c1", "b2", "c2", "c3"]);

    // Listeners on an unrelated event must survive too.
    const otherSeen = [];
    bus.on("other", (value) => otherSeen.push(value));
    bus.off("event", third);
    bus.emit("event", 4);
    bus.emit("other", "kept");
    equal("removing the last listener leaves the event silent", seen, [
      "a1",
      "b1",
      "c1",
      "b2",
      "c2",
      "c3",
    ]);
    equal("unrelated events keep their listeners", otherSeen, ["kept"]);

    const metrics = await importModule("src/metrics-subscriber.mjs");
    const audit = await importModule("src/audit-subscriber.mjs");
    const metricsBus = createEventBus();
    const stopAudit = audit.startAuditSubscriber(metricsBus);
    for (let index = 0; index < 4; index += 1) {
      const stop = metrics.startMetricsSubscriber(metricsBus);
      metricsBus.emit("order-placed", { orderId: index });
      stop();
      metricsBus.emit("order-placed", { orderId: `after-${index}` });
    }
    equal("repeated subscriber lifecycle does not leak", metrics.getMetricsCount(), 4);
    equal("an unrelated subscriber keeps receiving every event", audit.getAuditLog().length, 8);
    stopAudit();
    metricsBus.emit("order-placed", { orderId: "final" });
    equal("stopping the unrelated subscriber works too", audit.getAuditLog().length, 8);
  },

  // Prompt: "Validation must happen before saveItem, so a rejected adjustment leaves the stored item
  // unchanged." The prompt names saveItem but never an error class, so any rejection type is
  // accepted while the *ordering* is checked by observing calls into the store.
  "inventory-orientation-task": async ({
    importModule,
    writeModule,
    moveModule,
    equal,
    check,
    throws,
  }) => {
    // Install a pass-through probe over the store so the grader can see whether a rejected
    // adjustment reached saveItem at all. The probe changes no behavior.
    await moveModule("src/inventory-store.mjs", "src/inventory-store.__origin.mjs");
    await writeModule(
      "src/inventory-store.mjs",
      `import * as origin from "./inventory-store.__origin.mjs";

// Pass-through probe. It changes no behavior; it records how the store was reached.
//
// __saveCalls answers "did a rejected adjustment persist?". __storeWrites answers the question the
// second independent audit showed that was not enough for: getItem hands back the LIVE stored
// object, so a candidate can write the adjustment straight into the store and restore it on
// rejection without ever calling saveItem. Every read is wrapped so such a write is observed.
export const __saveCalls = [];
export const __storeWrites = [];

const track = (item) =>
  item && typeof item === "object"
    ? new Proxy(item, {
        set(target, property, value, receiver) {
          __storeWrites.push({ kind: "set", property: String(property), value });
          return Reflect.set(target, property, value, receiver);
        },
        deleteProperty(target, property) {
          __storeWrites.push({ kind: "delete", property: String(property) });
          return Reflect.deleteProperty(target, property);
        },
      })
    : item;

export function saveItem(item) {
  const plain = item && typeof item === "object" ? { ...item } : item;
  __saveCalls.push(plain);
  return origin.saveItem(plain);
}
export function getItem(sku) {
  return track(origin.getItem(sku));
}
export function allItems() {
  return origin.allItems();
}
`,
    );

    const store = await importModule("src/inventory-store.mjs");
    const { addItem } = await importModule("src/operations/add-item.mjs");
    const { restockItem } = await importModule("src/operations/restock-item.mjs");

    addItem("sku-a", "Widget", 10);
    equal("addItem behavior is intact", store.getItem("sku-a").quantity, 10);
    await throws("addItem still rejects a duplicate", () => addItem("sku-a", "Widget", 1), Error);

    equal("allows signed adjustment with valid result", restockItem("sku-a", -3).quantity, 7);
    equal("valid adjustment is persisted", store.getItem("sku-a").quantity, 7);
    equal("positive restock still works", restockItem("sku-a", 5).quantity, 12);
    equal("zero adjustment is accepted", restockItem("sku-a", 0).quantity, 12);
    equal("adjustment down to exactly zero is accepted", restockItem("sku-a", -12).quantity, 0);
    restockItem("sku-a", 12);

    await throws("rejects a missing item", () => restockItem("sku-missing", 1), Error);

    // Each rejected adjustment must be rejected *before* the store is written.
    const rejections = [
      ["negative resulting quantity", -20],
      ["fractional adjustment", 0.5],
      ["fractional negative adjustment", -0.5],
      ["large negative adjustment", -1_000],
    ];
    for (const [label, adjustment] of rejections) {
      store.__saveCalls.length = 0;
      store.__storeWrites.length = 0;
      await throws(`rejects ${label}`, () => restockItem("sku-a", adjustment), REJECTION);
      check(
        `rejected adjustment (${label}) never reaches saveItem`,
        store.__saveCalls.length === 0,
        `saveItem was called ${store.__saveCalls.length} time(s) for a rejected adjustment: ${JSON.stringify(store.__saveCalls)}`,
      );
      check(
        `rejected adjustment (${label}) never writes into the stored item`,
        store.__storeWrites.length === 0,
        `the stored item was written ${store.__storeWrites.length} time(s) during a rejected adjustment: ${JSON.stringify(store.__storeWrites.slice(0, 4))}`,
      );
      equal(`rejected adjustment (${label}) is atomic`, store.getItem("sku-a").quantity, 12);
    }

    store.__saveCalls.length = 0;
    equal(
      "accepted adjustment still persists after rejections",
      restockItem("sku-a", -2).quantity,
      10,
    );
    check(
      "an accepted adjustment does reach saveItem",
      store.__saveCalls.length >= 1,
      "expected saveItem to be called for an accepted adjustment",
    );
  },

  // Prompt names TypeError for non-integer endpoints and RangeError for reversed ranges.
  "backward-compat-date-regression": async ({ importModule, equal, check, throws }) => {
    const { overlapDays } = await importModule("src/date-range.mjs");
    equal("touching inclusive ranges share one day", overlapDays(1, 5, 5, 10), 1);
    equal("contained overlap is inclusive", overlapDays(2, 10, 4, 6), 3);
    equal("disjoint ranges return zero", overlapDays(1, 2, 4, 5), 0);
    equal("adjacent ranges return zero", overlapDays(1, 2, 3, 4), 0);
    equal("identical single-day ranges", overlapDays(7, 7, 7, 7), 1);
    equal("full containment", overlapDays(1, 10, 1, 10), 10);
    equal("argument order does not matter", overlapDays(4, 6, 2, 10), 3);
    equal("negative day indexes work", overlapDays(-5, -1, -3, 3), 3);

    // Property sweep against an independent inclusive-overlap definition.
    let agrees = true;
    for (let aStart = -3; aStart <= 3; aStart += 1) {
      for (let aEnd = aStart; aEnd <= aStart + 4; aEnd += 1) {
        for (let bStart = -3; bStart <= 3; bStart += 1) {
          for (let bEnd = bStart; bEnd <= bStart + 4; bEnd += 1) {
            const expected = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1);
            if (overlapDays(aStart, aEnd, bStart, bEnd) !== expected) agrees = false;
          }
        }
      }
    }
    check(
      "inclusive overlap generalizes across ranges",
      agrees,
      "overlap diverged from the inclusive definition",
    );

    await throws("rejects reversed first range", () => overlapDays(2, 1, 3, 4), RangeError);
    await throws("rejects reversed second range", () => overlapDays(1, 2, 4, 3), RangeError);
    await throws("rejects non-integer endpoints", () => overlapDays(1, 2.5, 2, 3), TypeError);
    await throws("rejects non-numeric endpoints", () => overlapDays(1, "2", 2, 3), TypeError);
  },

  // Prompt: "Require a non-empty string task ID and finite numeric timestamps, throwing TypeError
  // otherwise" -- both declared timestamps of scheduleReminder are covered.
  "past-due-reminder-handling": async ({ importModule, equal, check, throws }) => {
    const scheduler = await importModule("src/reminder-scheduler.mjs");
    scheduler.scheduleReminder("past", 90, 100);
    scheduler.scheduleReminder("now", 100, 100);
    scheduler.scheduleReminder("future", 120, 100);
    equal(
      "all accepted reminders are scheduled in insertion order",
      scheduler.listScheduled().map((item) => item.taskId),
      ["past", "now", "future"],
    );
    equal(
      "past and current reminders are due",
      scheduler.dueReminders(100).map((item) => item.taskId),
      ["past", "now"],
    );
    equal(
      "a later clock makes the future reminder due too",
      scheduler.dueReminders(130).map((item) => item.taskId),
      ["past", "now", "future"],
    );
    equal("an earlier clock makes nothing due", scheduler.dueReminders(50).length, 0);

    const copy = scheduler.listScheduled();
    copy.length = 0;
    equal("list is a defensive copy", scheduler.listScheduled().length, 3);
    const dueCopy = scheduler.dueReminders(130);
    dueCopy.length = 0;
    equal("due list is a defensive copy", scheduler.dueReminders(130).length, 3);

    const before = scheduler.listScheduled().length;
    await throws("rejects empty task id", () => scheduler.scheduleReminder("", 1, 2), TypeError);
    await throws(
      "rejects non-string task id",
      () => scheduler.scheduleReminder(7, 1, 2),
      TypeError,
    );
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "soon", null]) {
      const label = String(bad);
      await throws(
        `rejects invalid remindAt (${label})`,
        () => scheduler.scheduleReminder("x", bad, 2),
        TypeError,
      );
      await throws(
        `rejects invalid now (${label})`,
        () => scheduler.scheduleReminder("x", 1, bad),
        TypeError,
      );
    }
    check(
      "rejected reminders are not scheduled",
      scheduler.listScheduled().length === before,
      `expected ${before} scheduled reminders, found ${scheduler.listScheduled().length}`,
    );
  },

  // Prompt names RangeError and defines containment as "resolves inside outDir". The grader
  // generates candidate paths systematically and defers to an independent resolution oracle, so no
  // attack literal is special-cased and over-rejection is caught alongside under-rejection.
  "report-output-path-boundary": async ({ workspace, importModule, equal, check, throws }) => {
    const { writeReportFile } = await importModule("src/report-writer.mjs");
    const outDir = path.join(workspace, "generated");
    const root = path.resolve(outDir);
    const resolvesInside = (requested) => {
      const target = path.resolve(root, requested);
      return target !== root && target.startsWith(`${root}${path.sep}`);
    };

    const before = await listFiles(workspace);

    const tails = ["report.txt", "nested/report.txt", "a/b/c/report.txt"];
    const prefixes = [
      "",
      "./",
      "sub/",
      "sub/./",
      "../",
      "..\\",
      "../../",
      "sub/../",
      "sub/../../",
      "a/b/../../../",
      "./../",
      ".././../",
    ];
    const requests = new Set();
    for (const tail of tails) {
      for (const prefix of prefixes) {
        requests.add(`${prefix}${tail}`);
        requests.add(`${prefix}${tail}`.replaceAll("/", "\\"));
      }
    }
    requests.add(path.join(root, "absolute.txt"));
    requests.add(path.join(root, "deep", "absolute.txt"));
    requests.add(`${root}-sibling${path.sep}bad.txt`);
    requests.add(`${root}${path.sep}..${path.sep}bad.txt`);
    requests.add(path.join(workspace, "escaped.txt"));
    requests.add(path.join(workspace, "..", "escaped.txt"));

    const disagreements = [];
    let accepted = 0;
    let rejected = 0;
    for (const requested of requests) {
      const shouldAccept = resolvesInside(requested);
      let outcome;
      try {
        outcome = { ok: true, returned: writeReportFile(outDir, requested, `probe:${requested}`) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      if (outcome.ok !== shouldAccept) {
        disagreements.push(
          `${JSON.stringify(requested)} resolves ${shouldAccept ? "inside" : "outside"} outDir but was ${outcome.ok ? "accepted" : "rejected"}`,
        );
        continue;
      }
      if (shouldAccept) {
        accepted += 1;
        const expectedTarget = path.resolve(root, requested);
        if (path.resolve(outcome.returned) !== expectedTarget) {
          disagreements.push(
            `${JSON.stringify(requested)} returned ${outcome.returned}, expected ${expectedTarget}`,
          );
          continue;
        }
        const written = await readFile(expectedTarget, "utf8").catch(() => null);
        if (written !== `probe:${requested}`) {
          disagreements.push(`${JSON.stringify(requested)} did not write its content`);
        }
      } else {
        rejected += 1;
        if (!(outcome.error instanceof RangeError)) {
          disagreements.push(
            `${JSON.stringify(requested)} was rejected with ${outcome.error?.constructor?.name ?? "no error"}, expected RangeError`,
          );
        }
      }
    }
    check(
      "canonical containment holds for every generated path",
      disagreements.length === 0,
      disagreements.slice(0, 6).join("; ") ||
        "all generated paths agreed with canonical resolution",
    );
    check(
      "the sweep exercised contained paths",
      accepted >= 8,
      `only ${accepted} contained paths were accepted`,
    );
    check(
      "the sweep exercised escaping paths",
      rejected >= 8,
      `only ${rejected} escaping paths were rejected`,
    );

    // Independent safety property: nothing the sweep created may live outside outDir.
    const after = await listFiles(workspace);
    const created = after.filter((entry) => !before.includes(entry));
    const escapedFiles = created.filter((entry) => {
      const absolute = path.resolve(workspace, entry);
      return absolute !== root && !absolute.startsWith(`${root}${path.sep}`);
    });
    check(
      "no write landed outside the configured directory",
      escapedFiles.length === 0,
      `files written outside outDir: ${escapedFiles.slice(0, 6).join(", ")}`,
    );

    equal(
      "writes relative contained path",
      await readFile(writeReportFile(outDir, "final/report.txt", "relative"), "utf8"),
      "relative",
    );
    const absoluteRequest = path.join(outDir, "final-absolute.txt");
    equal(
      "accepts safe absolute contained path",
      path.resolve(writeReportFile(outDir, absoluteRequest, "absolute")),
      path.resolve(absoluteRequest),
    );
    await throws(
      "rejects parent traversal",
      () => writeReportFile(outDir, "../escaped-final.txt", "bad"),
      RangeError,
    );
  },

  // Prompt: exactly one concurrent winner per key, audit-logged keys never reserved, keys
  // independent, release re-opens a key, and the claim must not rely on timing delays.
  "idempotency-key-race": async ({ importModule, equal, check }) => {
    const store = await importModule("src/idempotency-store.mjs");

    for (const [round, width] of [
      [1, 8],
      [2, 3],
      [3, 16],
    ]) {
      const key = `race-${round}`;
      const results = await Promise.all(Array.from({ length: width }, () => store.reserveKey(key)));
      equal(
        `round ${round}: exactly one concurrent reservation wins`,
        results.filter(Boolean).length,
        1,
      );
    }

    const keys = ["a", "b", "c", "d"];
    equal(
      "different keys proceed independently",
      await Promise.all(keys.map((key) => store.reserveKey(key))),
      keys.map(() => true),
    );
    equal(
      "a second attempt on a held key fails for every key",
      await Promise.all(keys.map((key) => store.reserveKey(key))),
      keys.map(() => false),
    );

    for (const key of keys) store.releaseKey(key);
    equal(
      "release permits later reservation for every key",
      await Promise.all(keys.map((key) => store.reserveKey(key))),
      keys.map(() => true),
    );

    store.markRecorded("recorded");
    equal("persistent audit record blocks reservation", await store.reserveKey("recorded"), false);
    store.markRecorded("recorded-concurrent");
    const audited = await Promise.all(
      Array.from({ length: 6 }, () => store.reserveKey("recorded-concurrent")),
    );
    check(
      "an audited key is never reserved, even concurrently",
      audited.every((value) => value === false),
      `expected every concurrent reservation of an audited key to fail, got ${JSON.stringify(audited)}`,
    );

    store.releaseKey("release-then-audit");
    equal("a fresh key can be reserved", await store.reserveKey("release-then-audit"), true);
    store.releaseKey("release-then-audit");
    store.markRecorded("release-then-audit");
    equal(
      "release does not defeat the audit log",
      await store.reserveKey("release-then-audit"),
      false,
    );
  },

  // Prompt enumerates the retry classification exhaustively, so the grader sweeps every documented
  // class rather than sampling one status per class.
  "webhook-retry-terminal-state": async ({ importModule, equal, check }) => {
    const { deliverWebhook } = await importModule("src/webhook-delivery.mjs");
    const deliver = async (status) => {
      let calls = 0;
      const result = await deliverWebhook({ id: status }, async () => {
        calls += 1;
        return { status };
      });
      return { result, calls };
    };

    for (const status of [200, 201, 202, 204, 299]) {
      equal(`2xx ${status} delivers on the first attempt`, await deliver(status), {
        result: { status: "DELIVERED", attempts: 1 },
        calls: 1,
      });
    }
    for (const status of [400, 401, 403, 404, 410]) {
      equal(`documented terminal ${status} is rejected once`, await deliver(status), {
        result: { status: "REJECTED", attempts: 1 },
        calls: 1,
      });
    }
    for (const status of [402, 418, 451, 300, 301]) {
      equal(`undocumented status ${status} is terminal`, await deliver(status), {
        result: { status: "REJECTED", attempts: 1 },
        calls: 1,
      });
    }
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      equal(`retryable ${status} exhausts at five attempts`, await deliver(status), {
        result: { status: "RETRY_EXHAUSTED", attempts: 5 },
        calls: 5,
      });
    }
    for (const status of [408, 425, 429, 503]) {
      let calls = 0;
      const recovered = await deliverWebhook({}, async () => ({
        status: ++calls === 3 ? 204 : status,
      }));
      equal(`retryable ${status} can recover`, recovered, { status: "DELIVERED", attempts: 3 });
    }

    // A mixed sequence must keep counting attempts across differing retryable statuses.
    const sequence = [503, 429, 408, 425, 500];
    let index = 0;
    const mixed = await deliverWebhook({}, async () => ({ status: sequence[index++] }));
    equal("mixed retryable statuses exhaust together", mixed, {
      status: "RETRY_EXHAUSTED",
      attempts: 5,
    });

    // A terminal status encountered mid-retry stops immediately.
    let terminalCalls = 0;
    const terminalAfterRetry = await deliverWebhook({}, async () => {
      terminalCalls += 1;
      return { status: terminalCalls < 3 ? 503 : 404 };
    });
    check(
      "a terminal status during retries stops immediately",
      terminalAfterRetry.status === "REJECTED" &&
        terminalAfterRetry.attempts === 3 &&
        terminalCalls === 3,
      `got ${JSON.stringify(terminalAfterRetry)} after ${terminalCalls} calls`,
    );

    const started = Date.now();
    await deliver(503);
    check(
      "retries add no wall-clock delay",
      Date.now() - started < 1_000,
      "retrying five times took over a second",
    );
  },
};

async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)));
}
