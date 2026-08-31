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

  // Prompt: a subscription opened after a price update captures the current price for that plan;
  // existing records stay unchanged when prices change later; unknown plans still reject.
  "subscription-price-mismatch": async ({ importModule, equal, check, throws }) => {
    const { openSubscriptionAtPrice } = await importModule("src/bootstrap.mjs");
    const { subscriptionRepository } = await importModule("src/repositories/subscription-repository.mjs");

    const opened = [];
    const sequence = [
      ["user-a", "pro", 34.5],
      ["user-b", "basic", 14.25],
      ["user-c", "pro", 39],
      ["user-d", "enterprise", 120],
      ["user-e", "basic", 11],
      ["user-f", "pro", 41.75],
      ["user-g", "enterprise", 130.5],
    ];
    for (const [userId, planId, price] of sequence) {
      const record = openSubscriptionAtPrice(userId, planId, price);
      equal(`${userId} on ${planId} captures the current price ${price}`, record.priceAtSubscription, price);
      opened.push({ record, price });
    }

    // Every earlier record must keep the price it captured after all the later updates.
    const drifted = opened.filter(({ record, price }) => record.priceAtSubscription !== price);
    check(
      "earlier records keep their captured price after later updates",
      drifted.length === 0,
      `records whose captured price changed: ${JSON.stringify(drifted.map(({ record }) => record.userId))}`,
    );
    equal(
      "the repository stores every captured price in order",
      subscriptionRepository.all().map((record) => record.priceAtSubscription),
      sequence.map(([, , price]) => price),
    );
    equal(
      "the stored subscription shape is preserved",
      Object.keys(subscriptionRepository.all()[0]).toSorted(),
      ["planId", "priceAtSubscription", "userId"],
    );
    equal(
      "repeated price changes on one plan are each captured",
      subscriptionRepository.all().filter((record) => record.planId === "pro").map((record) => record.priceAtSubscription),
      [34.5, 39, 41.75],
    );
    await throws("unknown plans still reject", () => openSubscriptionAtPrice("user-x", "missing", 10), Error);
    equal("a rejected subscription is not stored", subscriptionRepository.all().length, sequence.length);
  },

  // Prompt: one assignment command publishes exactly one observable update, and each later
  // reassignment is a distinct transition that adds exactly one more.
  "task-update-duplication": async ({ importModule, equal, check }) => {
    const { runAssignmentScenario } = await importModule("src/bootstrap.mjs");
    const { assignTaskCommand } = await importModule("src/commands/assign-task-command.mjs");
    const { getTaskAssignments } = await importModule("src/projections/task-summary-projection.mjs");
    const { taskRepository } = await importModule("src/repositories/task-repository.mjs");
    const { eventBus } = await importModule("src/events/event-bus.mjs");
    const { EVENT_TYPES } = await importModule("src/events/event-types.mjs");

    // An independent subscriber sees what the application actually publishes. This says nothing
    // about *where* the duplicate effect is removed -- dropping either emit satisfies it -- but a
    // projection that silently discards half of the events it receives does not.
    const published = [];
    eventBus.on(EVENT_TYPES.TASK_ASSIGNED, (payload) => published.push(payload));

    const first = runAssignmentScenario("project-a", "Investigate", "user-a");
    equal("one assignment produces one update", first.updates, [{ userId: "user-a", taskId: first.task.id }]);
    equal("assignment persists", taskRepository.get(first.task.id).assigneeId, "user-a");
    equal("one assignment publishes one event", published, [{ taskId: first.task.id, userId: "user-a" }]);

    // Every subsequent transition must contribute exactly one update. A "drop every other write"
    // shortcut satisfies a single reassignment but not a run of them.
    const reassignments = ["user-b", "user-c", "user-d", "user-e", "user-f"];
    const perTransition = [];
    const perTransitionEvents = [];
    for (const userId of reassignments) {
      const before = getTaskAssignments().length;
      const publishedBefore = published.length;
      assignTaskCommand(first.task.id, userId);
      perTransition.push(getTaskAssignments().slice(before));
      perTransitionEvents.push(published.length - publishedBefore);
      equal(`reassignment to ${userId} persists`, taskRepository.get(first.task.id).assigneeId, userId);
    }
    check(
      "each transition publishes exactly one event",
      perTransitionEvents.every((count) => count === 1),
      `events published per transition: ${JSON.stringify(perTransitionEvents)}`,
    );
    equal(
      "each reassignment produces exactly one update",
      perTransition,
      reassignments.map((userId) => [{ userId, taskId: first.task.id }]),
    );
    equal(
      "the projection holds one update per transition overall",
      getTaskAssignments().length,
      1 + reassignments.length,
    );

    // Assignments on an independent task must also produce one update each.
    const second = runAssignmentScenario("project-b", "Second", "user-z");
    equal("an independent task produces one update", second.updates, [{ userId: "user-z", taskId: second.task.id }]);
    const beforeInterleaved = getTaskAssignments().length;
    assignTaskCommand(first.task.id, "user-final");
    assignTaskCommand(second.task.id, "user-other");
    equal("interleaved assignments each produce one update", getTaskAssignments().slice(beforeInterleaved), [
      { userId: "user-final", taskId: first.task.id },
      { userId: "user-other", taskId: second.task.id },
    ]);
    check(
      "the event payload shape is preserved",
      getTaskAssignments().every((update) => Object.keys(update).toSorted().join(",") === "taskId,userId"),
      "assignment updates must carry exactly userId and taskId",
    );
  },

  // Prompt: a successful completion must *persist* the terminal state and publish exactly one
  // update. Persistence is checked through every repository read path, so a state synthesized on
  // read is not a pass.
  "completion-state-regression": async ({ importModule, equal, check, throws }) => {
    const { runCompletionScenario } = await importModule("src/bootstrap.mjs");
    const { completeTaskCommand } = await importModule("src/commands/complete-task-command.mjs");
    const { createTaskCommand } = await importModule("src/commands/create-task-command.mjs");
    const { getTaskCompletions } = await importModule("src/projections/task-summary-projection.mjs");
    const { taskRepository } = await importModule("src/repositories/task-repository.mjs");

    const first = runCompletionScenario("project-a", "Persist me");
    equal("completion result is terminal", first.completed.status, "COMPLETED");
    check("completion result carries a timestamp", first.completed.completedAt !== null, "completedAt must not be null");
    equal("subsequent read is terminal", taskRepository.get(first.completed.id).status, "COMPLETED");
    equal("completion timestamp is persisted", taskRepository.get(first.completed.id).completedAt, first.completed.completedAt);
    equal("one completion produces one update", first.updates, [{ userId: null, taskId: first.completed.id }]);

    // "Persist" means every read path over the repository agrees, not that one accessor
    // reconstructs a terminal-looking object.
    const readPaths = {
      get: taskRepository.get(first.completed.id),
      listByProject: taskRepository.listByProject("project-a").find((task) => task.id === first.completed.id),
      all: taskRepository.all().find((task) => task.id === first.completed.id),
    };
    const disagreeing = Object.entries(readPaths).filter(
      ([, task]) => task?.status !== "COMPLETED" || task?.completedAt !== first.completed.completedAt,
    );
    check(
      "every repository read path observes the persisted completion",
      disagreeing.length === 0,
      `read paths that did not observe the completion: ${disagreeing.map(([name, task]) => `${name}=${JSON.stringify(task?.status ?? null)}`).join(", ")}`,
    );

    const before = getTaskCompletions().length;
    await throws("missing task rejects", () => completeTaskCommand("missing-task"), Error);
    equal("failed completion emits no update", getTaskCompletions().length, before);

    // The behavior must hold for arbitrary tasks and repeat cleanly.
    const second = runCompletionScenario("project-b", "Another task");
    equal("arbitrary task IDs persist", taskRepository.get(second.completed.id), second.completed);
    equal("the second completion also publishes one update", second.updates, [{ userId: null, taskId: second.completed.id }]);

    const extra = createTaskCommand("project-c", "Third task");
    const beforeThird = getTaskCompletions().length;
    const completedThird = completeTaskCommand(extra.id);
    equal("a directly completed task persists too", taskRepository.get(extra.id).status, "COMPLETED");
    equal("a directly completed task persists its timestamp", taskRepository.get(extra.id).completedAt, completedThird.completedAt);
    equal("a directly completed task publishes one update", getTaskCompletions().slice(beforeThird), [
      { userId: null, taskId: extra.id },
    ]);
    equal(
      "unrelated tasks are untouched by a completion",
      taskRepository.all().filter((task) => task.status !== "COMPLETED").length,
      taskRepository.all().length - 3,
    );
    check(
      "the completion payload shape is preserved",
      getTaskCompletions().every((update) => Object.keys(update).toSorted().join(",") === "taskId,userId"),
      "completion updates must carry exactly userId and taskId",
    );
  },
};
