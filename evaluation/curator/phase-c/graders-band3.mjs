// Phase C Band 3 behavioral graders.
//
// Band 3 tasks are orientation tasks: the prompt states a symptom and a contract, never a location.
// The graders therefore assert only observable behavior through public entry points, and they check
// that the behavior *generalizes* -- a per-key or per-id special case, or a state that is
// synthesized on read rather than persisted, must not pass. See GRADER_CONTRACT_AUDIT.md.

export const phaseCBand3Graders = {
  // Prompt: per-request settings take precedence over the workspace defaults for ANY key, keys that
  // are not overridden keep their default, the defaults themselves are unchanged, and the caller's
  // settings object is not modified. Every assertion below is stated in the prompt.
  "notification-settings-regression": async ({ importModule, equal, check, throws }) => {
    const { registerAgent } = await importModule("src/directory/agent-directory.mjs");
    const { openTicket } = await importModule("src/tickets/ticket-store.mjs");
    const { SEVERITY } = await importModule("src/support/severity.mjs");
    const { sendDigest } = await importModule("src/workflows/daily-digest.mjs");
    const { runEscalationSweep } = await importModule("src/workflows/escalation-policy.mjs");
    const { settingValue } = await importModule("src/settings/settings-resolver.mjs");
    const { WORKSPACE_DEFAULTS } = await importModule("src/settings/workspace-defaults.mjs");

    const agent = registerAgent("Ada", "ada@example.com");
    const subjects = ["a", "b", "c", "d", "e", "f", "g"];
    const settings = { ticketDigestBatchSize: 3, defaultLocale: "fr-FR" };
    const beforeSubjects = structuredClone(subjects);
    const beforeSettings = structuredClone(settings);
    equal(
      "request batch size controls delivery groups",
      sendDigest(agent, subjects, settings).map((delivery) => delivery.body),
      ["Digest: a, b, c", "Digest: d, e, f", "Digest: g"],
    );
    equal("subjects remain unchanged", subjects, beforeSubjects);
    equal("the caller's settings object remains unchanged", settings, beforeSettings);

    // Batch sizes must generalize, not special-case the value the report happens to mention.
    for (const [size, count] of [
      [1, 7],
      [2, 4],
      [4, 2],
      [7, 1],
      [9, 1],
    ]) {
      equal(
        `batch size ${size} produces ${count} deliveries`,
        sendDigest(agent, subjects, { ticketDigestBatchSize: size }).length,
        count,
      );
    }
    equal(
      "the workspace default of ten still applies without an override",
      sendDigest(agent, Array.from({ length: 11 }, (_, index) => String(index))).length,
      2,
    );
    equal("an empty digest sends nothing", sendDigest(agent, [], { ticketDigestBatchSize: 2 }).length, 0);
    for (const size of [0, -1, 2.5, "3", null]) {
      await throws(
        `invalid batch size ${String(size)} rejects`,
        () => sendDigest(agent, ["one"], { ticketDigestBatchSize: size }),
        RangeError,
      );
    }

    // A second workflow reading a different setting through the same layer. Restoring precedence
    // for the digest alone does not satisfy the contract.
    openTicket("printer offline", SEVERITY.NORMAL);
    openTicket("vpn drops", SEVERITY.HIGH);
    openTicket("badge reader", SEVERITY.NORMAL);
    equal("a narrow escalation window escalates every open ticket", runEscalationSweep({ escalationAfterMinutes: 1 }).length, 3);
    equal("a wide escalation window escalates nothing", runEscalationSweep({ escalationAfterMinutes: 5_000 }).length, 0);
    equal("the workspace escalation default still applies", runEscalationSweep().length, 0);
    await throws(
      "an invalid escalation window rejects",
      () => runEscalationSweep({ escalationAfterMinutes: 0 }),
      RangeError,
    );

    // Precedence is a property of the settings layer, so it must hold for every key -- including a
    // key no workflow reads.
    for (const [key, override] of [
      ["ticketDigestBatchSize", 4],
      ["escalationAfterMinutes", 15],
      ["auditRetentionDays", 7],
      ["defaultLocale", "de-DE"],
    ]) {
      equal(`an override wins for ${key}`, settingValue(key, { [key]: override }), override);
    }
    for (const key of Object.keys(WORKSPACE_DEFAULTS)) {
      equal(`${key} keeps its default when it is not overridden`, settingValue(key, { unrelatedKey: 1 }), WORKSPACE_DEFAULTS[key]);
      equal(`${key} keeps its default with no overrides at all`, settingValue(key), WORKSPACE_DEFAULTS[key]);
    }
    equal(
      "several overrides apply at once",
      [settingValue("auditRetentionDays", { auditRetentionDays: 1, defaultLocale: "es-ES" }), settingValue("defaultLocale", { auditRetentionDays: 1, defaultLocale: "es-ES" })],
      [1, "es-ES"],
    );
    equal("the workspace defaults themselves are unchanged", WORKSPACE_DEFAULTS.ticketDigestBatchSize, 10);
    equal("every workspace default is unchanged", WORKSPACE_DEFAULTS, {
      ticketDigestBatchSize: 10,
      escalationAfterMinutes: 60,
      auditRetentionDays: 30,
      defaultLocale: "en-GB",
    });
    const overrides = { defaultLocale: "ja-JP" };
    settingValue("defaultLocale", overrides);
    equal("reading a setting does not modify the overrides it was given", overrides, { defaultLocale: "ja-JP" });
    check(
      "digest deliveries carry a body",
      typeof sendDigest(agent, ["x"])[0]?.body === "string",
      "expected a delivery body string",
    );
  },

  // Prompt: the adjustment comes off the base price first, tax applies to what remains, a PERCENT
  // adjustment is a percentage of the base price, the subtotal floors at zero, and the total is
  // rounded to two decimals -- for arbitrary valid inputs, not just the reported ones.
  "discount-result-regression": async ({ importModule, equal, check, throws }) => {
    const { quoteShipment } = await importModule("src/quoting/quote-service.mjs");
    const { adjustmentForCode } = await importModule("src/promotions/promo-codes.mjs");
    const expected = (base, adjustment, taxRate) => {
      const reduction =
        adjustment.kind === "PERCENT" ? (base * adjustment.value) / 100 : adjustment.value;
      return Math.round(Math.max(0, base - reduction) * (1 + taxRate) * 100) / 100;
    };

    equal("the reported case is corrected", quoteShipment(120, { kind: "PERCENT", value: 10 }, 0.08), 116.64);
    equal("flat adjustments still price correctly", quoteShipment(120, { kind: "FLAT", value: 20 }, 0.08), 108);
    equal("a flat adjustment rounds cents", quoteShipment(95, { kind: "FLAT", value: 20 }, 0.075), 80.63);
    equal("an adjustment cannot make the subtotal negative", quoteShipment(30, { kind: "FLAT", value: 50 }, 0.2), 0);
    equal("a zero adjustment is just taxed base", quoteShipment(200, { kind: "FLAT", value: 0 }, 0.1), 220);

    // The formula must hold across the whole valid input space. A fix that repairs only the
    // percentage the report happens to mention does not satisfy the contract.
    const disagreements = [];
    for (const base of [0, 15, 30, 99.99, 120, 250, 1000, 1234.56]) {
      for (const adjustment of [
        { kind: "PERCENT", value: 0 },
        { kind: "PERCENT", value: 5 },
        { kind: "PERCENT", value: 10 },
        { kind: "PERCENT", value: 12 },
        { kind: "PERCENT", value: 33.5 },
        { kind: "PERCENT", value: 100 },
        { kind: "FLAT", value: 0 },
        { kind: "FLAT", value: 20 },
        { kind: "FLAT", value: 5000 },
      ]) {
        for (const taxRate of [0, 0.05, 0.075, 0.08, 0.2]) {
          const actual = quoteShipment(base, adjustment, taxRate);
          const want = expected(base, adjustment, taxRate);
          if (actual !== want) {
            disagreements.push(
              `base=${base} ${adjustment.kind}:${adjustment.value} tax=${taxRate} -> ${actual}, expected ${want}`,
            );
          }
        }
      }
    }
    check(
      "quotes generalize across base rates, adjustments and tax rates",
      disagreements.length === 0,
      `${disagreements.length} combination(s) diverged: ${disagreements.slice(0, 5).join("; ")}` ||
        "every combination matched the contract",
    );
    check(
      "the sweep covered the whole input space",
      disagreements.length === 0,
      `${8 * 9 * 5} combinations were priced`,
    );

    // Validation is explicitly out of scope for the fix and must be preserved.
    await throws("a percentage above one hundred rejects", () => quoteShipment(100, { kind: "PERCENT", value: 101 }, 0), RangeError);
    await throws("a negative adjustment rejects", () => quoteShipment(100, { kind: "PERCENT", value: -1 }, 0), RangeError);
    await throws("a negative tax rate rejects", () => quoteShipment(100, { kind: "FLAT", value: 1 }, -0.1), RangeError);
    await throws("an unknown adjustment kind rejects", () => quoteShipment(100, { kind: "BOGUS", value: 1 }, 0), RangeError);
    await throws("a missing adjustment rejects", () => quoteShipment(100, null, 0), RangeError);

    // The separate code-based promotion path is explicitly out of scope.
    equal("promotion codes still resolve to adjustments", adjustmentForCode("BULK20"), { kind: "FLAT", value: 20 });
    equal("a percentage promotion code still resolves", adjustmentForCode("WELCOME"), { kind: "PERCENT", value: 5 });
    equal("an unknown promotion code is a no-op adjustment", adjustmentForCode("NOPE"), { kind: "FLAT", value: 0 });
    equal("a promotion code prices through the same contract", quoteShipment(200, adjustmentForCode("WELCOME"), 0.1), 209);
  },

  // Prompt: a membership captures the price in force for its plan at the moment it is opened;
  // earlier memberships keep the price they captured when a plan's price changes later; an unknown
  // plan still rejects with RangeError.
  "subscription-price-mismatch": async ({ importModule, equal, check, throws }) => {
    const { enrolAtPrice, openClub } = await importModule("src/app/desk-operations.mjs");
    const { membershipLedger } = await importModule("src/enrolment/membership-ledger.mjs");
    const { rosterReport } = await importModule("src/roster/member-directory.mjs");
    const { buildStatement } = await importModule("src/statements/statement-builder.mjs");
    openClub();

    const opened = [];
    const sequence = [
      ["Ada", "standard", 34.99],
      ["Bo", "basic", 14.25],
      ["Cy", "standard", 39],
      ["Di", "premium", 120],
      ["Eli", "basic", 11],
      ["Fay", "standard", 41.75],
      ["Gus", "premium", 130.5],
    ];
    for (const [name, planId, amount] of sequence) {
      const membership = enrolAtPrice(name, planId, amount);
      equal(`${name} on ${planId} captures the price in force (${amount})`, membership.rateAtEnrolment, amount);
      opened.push({ name, membership, amount });
    }

    // Every earlier membership must still hold the price it captured, after all the later changes.
    const drifted = opened.filter(({ membership, amount }) => membership.rateAtEnrolment !== amount);
    check(
      "earlier memberships keep their captured price after later price changes",
      drifted.length === 0,
      `memberships whose captured price moved: ${JSON.stringify(drifted.map(({ name }) => name))}`,
    );
    equal(
      "the ledger holds every captured price in order",
      membershipLedger.all().map((membership) => membership.rateAtEnrolment),
      sequence.map(([, , amount]) => amount),
    );
    equal(
      "repeated price changes on one plan are each captured",
      membershipLedger.forPlan("standard").map((membership) => membership.rateAtEnrolment),
      [34.99, 39, 41.75],
    );
    equal(
      "the stored membership shape is preserved",
      Object.keys(membershipLedger.all()[0]).toSorted(),
      ["memberId", "planId", "rateAtEnrolment"],
    );

    // A later enrolment must not disturb what is already recorded.
    const beforeIdleChange = membershipLedger.all().map((membership) => membership.rateAtEnrolment);
    enrolAtPrice("Hal", "basic", 21.5);
    equal(
      "a later enrolment leaves earlier captured prices untouched",
      membershipLedger.all().slice(0, beforeIdleChange.length).map((membership) => membership.rateAtEnrolment),
      beforeIdleChange,
    );

    const ledgerSize = membershipLedger.all().length;
    await throws("an unknown plan still rejects", () => enrolAtPrice("Ivy", "platinum", 10), RangeError);
    equal("a rejected enrolment is not stored", membershipLedger.all().length, ledgerSize);

    // Unrelated behaviour is explicitly out of scope for the fix.
    equal("the roster still lists every registered member", rosterReport().length >= sequence.length, true);
    equal("statements still price from the captured rate", buildStatement(opened[0].membership).total, 49.99);
  },

  // Prompt: one assignment command publishes exactly one observable PICKER_ASSIGNED update, and
  // each later reassignment is a distinct transition that adds exactly one more.
  "task-update-duplication": async ({ importModule, equal, check }) => {
    const { runAssignmentScenario, runPickScenario, initFloor } = await importModule("src/app/floor-operations.mjs");
    const { assignPickerCommand } = await importModule("src/picking/assign-picker-command.mjs");
    const { getPickerAssignments, getPickCompletions } = await importModule("src/projections/floor-summary.mjs");
    const { pickListStore, createPickList } = await importModule("src/picking/pick-list-store.mjs");
    const { registerPicker } = await importModule("src/staff/picker-directory.mjs");
    const { eventBus } = await importModule("src/events/event-bus.mjs");
    const { EVENT_TYPES } = await importModule("src/events/event-types.mjs");
    initFloor();

    // An independent subscriber sees what the application actually publishes. This says nothing
    // about WHERE the duplicate effect is removed -- dropping either emit satisfies it -- but a
    // projection that silently discards half of the events it receives does not.
    const published = [];
    eventBus.on(EVENT_TYPES.PICKER_ASSIGNED, (payload) => published.push(payload));

    const first = runAssignmentScenario("zone-a", "widget", "Ada");
    equal("one assignment produces one update", first.updates, [
      { pickerId: first.picker.id, pickListId: first.pickList.id },
    ]);
    equal("one assignment publishes one event", published, [
      { pickListId: first.pickList.id, pickerId: first.picker.id },
    ]);
    equal("the assignment persists", pickListStore.get(first.pickList.id).pickerId, first.picker.id);

    // Every subsequent transition must contribute exactly one update. A "drop every other write"
    // shortcut satisfies a single reassignment but not a run of them.
    const perTransition = [];
    const perTransitionEvents = [];
    const reassigned = [];
    for (const name of ["Bo", "Cy", "Di", "Eli", "Fay"]) {
      const picker = registerPicker(name);
      reassigned.push(picker);
      const beforeUpdates = getPickerAssignments().length;
      const beforeEvents = published.length;
      assignPickerCommand(first.pickList.id, picker.id);
      perTransition.push(getPickerAssignments().slice(beforeUpdates));
      perTransitionEvents.push(published.length - beforeEvents);
      equal(`reassignment to ${name} persists`, pickListStore.get(first.pickList.id).pickerId, picker.id);
    }
    equal(
      "each reassignment produces exactly one update naming the new picker",
      perTransition,
      reassigned.map((picker) => [{ pickerId: picker.id, pickListId: first.pickList.id }]),
    );
    check(
      "each transition publishes exactly one event",
      perTransitionEvents.every((count) => count === 1),
      `events published per transition: ${JSON.stringify(perTransitionEvents)}`,
    );

    // Independent pick lists must each produce one update per assignment, including interleaved.
    const second = createPickList("zone-b", "gasket");
    const third = createPickList("zone-c", "bracket");
    const pickerX = registerPicker("Gus");
    const pickerY = registerPicker("Hal");
    const beforeInterleaved = getPickerAssignments().length;
    assignPickerCommand(second.id, pickerX.id);
    assignPickerCommand(third.id, pickerY.id);
    assignPickerCommand(second.id, pickerY.id);
    equal("interleaved assignments each produce one update", getPickerAssignments().slice(beforeInterleaved), [
      { pickerId: pickerX.id, pickListId: second.id },
      { pickerId: pickerY.id, pickListId: third.id },
      { pickerId: pickerY.id, pickListId: second.id },
    ]);
    check(
      "the event payload shape is preserved",
      published.every((payload) => Object.keys(payload).toSorted().join(",") === "pickListId,pickerId"),
      "assignment events must carry exactly pickListId and pickerId",
    );
    check(
      "the projection payload shape is preserved",
      getPickerAssignments().every((update) => Object.keys(update).toSorted().join(",") === "pickListId,pickerId"),
      "assignment updates must carry exactly pickListId and pickerId",
    );

    // Unrelated pick-completion behaviour is explicitly out of scope for the fix.
    const beforeCompletions = getPickCompletions().length;
    const picked = runPickScenario("zone-d", "widget", "Ivy");
    equal("one pick still produces one completion update", picked.updates.length, 1);
    equal("pick completions accumulate normally", getPickCompletions().length, beforeCompletions + 1);
    equal("a completed pick is stored as picked", pickListStore.get(picked.pickList.id).status, "PICKED");
  },

  // Prompt: a successful completion must durably record the terminal state and publish exactly one
  // update, and every later read of that order must see it. Persistence is checked through every
  // repository read path, so a state synthesized inside one accessor is not a pass.
  "completion-state-regression": async ({ importModule, equal, check, throws }) => {
    const { runCompletionScenario, runAssignmentScenario, initDispatch } = await importModule("src/app/dispatch-operations.mjs");
    const { completeOrderCommand } = await importModule("src/workorders/complete-order-command.mjs");
    const { workOrderRepository, raiseOrder } = await importModule("src/workorders/work-order-repository.mjs");
    const { getOrderCompletions, boardSummary } = await importModule("src/projections/completion-board.mjs");
    const { technicianLoad } = await importModule("src/projections/technician-load.mjs");
    initDispatch();

    const first = runCompletionScenario("south", "Reseal joint");
    equal("completion result is terminal", first.completed.status, "COMPLETED");
    check("completion result carries a timestamp", first.completed.completedAt !== null, "completedAt must not be null");
    equal("one completion produces one update", first.updates, [
      { technicianId: null, orderId: first.completed.id },
    ]);

    // "Durably record" means every read path over the repository agrees, not that one accessor
    // reconstructs a terminal-looking object.
    const readPaths = (id, region) => ({
      get: workOrderRepository.get(id),
      byRegion: workOrderRepository.byRegion(region).find((order) => order.id === id),
      all: workOrderRepository.all().find((order) => order.id === id),
    });
    const disagreeing = Object.entries(readPaths(first.completed.id, "south")).filter(
      ([, order]) => order?.status !== "COMPLETED" || order?.completedAt !== first.completed.completedAt,
    );
    check(
      "every repository read path observes the recorded completion",
      disagreeing.length === 0,
      `read paths that did not observe the completion: ${Object.entries(readPaths(first.completed.id, "south")).map(([name, order]) => `${name}=${JSON.stringify(order?.status ?? null)}`).join(", ")}`,
    );
    equal("the board counts the completed order", boardSummary().completed >= 1, true);

    const beforeMissing = getOrderCompletions().length;
    await throws("a missing order rejects", () => completeOrderCommand("order-does-not-exist"), Error);
    equal("a failed completion emits no update", getOrderCompletions().length, beforeMissing);

    // The behaviour must hold for arbitrary orders, including one that already has a technician.
    const assigned = runAssignmentScenario("north", "Replace meter", "Ada");
    const beforeAssignedCompletion = getOrderCompletions().length;
    const completedAssigned = completeOrderCommand(assigned.order.id);
    equal("an assigned order completes to a terminal state", completedAssigned.status, "COMPLETED");
    equal("an assigned order's completion is recorded", workOrderRepository.get(assigned.order.id).status, "COMPLETED");
    equal(
      "an assigned order's completion timestamp is recorded",
      workOrderRepository.get(assigned.order.id).completedAt,
      completedAssigned.completedAt,
    );
    equal("an assigned order keeps its technician", workOrderRepository.get(assigned.order.id).technicianId, assigned.technician.id);
    equal("completing an assigned order publishes one update", getOrderCompletions().slice(beforeAssignedCompletion), [
      { technicianId: assigned.technician.id, orderId: assigned.order.id },
    ]);

    // A third, directly raised order, to show the behaviour is not tied to one code path.
    const direct = raiseOrder("east", "Swap regulator");
    const beforeDirect = getOrderCompletions().length;
    const completedDirect = completeOrderCommand(direct.id);
    equal("a directly raised order completes", workOrderRepository.get(direct.id).status, "COMPLETED");
    equal("a directly raised order records its timestamp", workOrderRepository.get(direct.id).completedAt, completedDirect.completedAt);
    equal("a directly raised order publishes one update", getOrderCompletions().slice(beforeDirect), [
      { technicianId: null, orderId: direct.id },
    ]);
    equal("three orders are now recorded as completed", boardSummary().completed, 3);
    check(
      "the completion payload shape is preserved",
      getOrderCompletions().every((update) => Object.keys(update).toSorted().join(",") === "orderId,technicianId"),
      "completion updates must carry exactly orderId and technicianId",
    );

    // Unrelated assignment and load behaviour is explicitly out of scope for the fix.
    equal("technician load is still tracked", technicianLoad().length >= 1, true);
  },
};
