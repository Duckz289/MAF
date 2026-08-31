// Phase C Band 3 behavioral graders.
//
// Band 3 tasks are orientation tasks: the prompt states a symptom and a contract, never a location.
// The graders therefore assert only observable behavior through public entry points, and they check
// that the behavior *generalizes* -- a per-key or per-id special case, or a state that is
// synthesized on read rather than persisted, must not pass. See GRADER_CONTRACT_AUDIT.md.

export const phaseCBand3Graders = {
  // Prompt: restore request-level configuration precedence for any key, keep the defaults for keys
  // that are not overridden, and leave the caller's objects unchanged.
  "notification-settings-regression": async ({ importModule, equal, check, throws }) => {
    const { createUser } = await importModule("src/services/user-service.mjs");
    const { sendDigest } = await importModule("src/services/notification-service.mjs");
    const { getConfigValue, resolveConfig } = await importModule("src/config/config-provider.mjs");
    const { DEFAULT_CONFIG } = await importModule("src/config/app-config.mjs");
    const user = createUser("Ada", "ada@example.com");

    const items = ["a", "b", "c", "d", "e", "f", "g"];
    const settings = { notificationDigestBatchSize: 3, defaultCurrency: "EUR" };
    const beforeItems = structuredClone(items);
    const beforeSettings = structuredClone(settings);
    equal(
      "request batch size controls delivery groups",
      sendDigest(user, items, settings).map((delivery) => delivery.message),
      ["Digest: a, b, c", "Digest: d, e, f", "Digest: g"],
    );
    equal("items remain unchanged", items, beforeItems);
    equal("settings remain unchanged", settings, beforeSettings);

    // Batch sizes must generalize, not special-case the value the symptom mentions.
    for (const [size, count] of [
      [1, 7],
      [2, 4],
      [4, 2],
      [7, 1],
      [9, 1],
    ]) {
      equal(
        `batch size ${size} produces ${count} deliveries`,
        sendDigest(user, items, { notificationDigestBatchSize: size }).length,
        count,
      );
    }
    equal(
      "default batch size remains ten",
      sendDigest(user, Array.from({ length: 11 }, (_, index) => String(index))).length,
      2,
    );
    equal("an empty digest sends nothing", sendDigest(user, [], { notificationDigestBatchSize: 2 }).length, 0);

    // Precedence is a property of the configuration layer, so it must hold for every key rather
    // than for the one the reported symptom happens to mention.
    for (const [key, override] of [
      ["notificationDigestBatchSize", 4],
      ["defaultCurrency", "EUR"],
      ["maxTasksPerProject", 7],
    ]) {
      equal(`request-level override wins for ${key}`, getConfigValue(key, { [key]: override }), override);
    }
    equal("unrelated keys keep their defaults", getConfigValue("defaultCurrency", { maxTasksPerProject: 1 }), "USD");
    equal("resolveConfig applies every override at once", resolveConfig({ defaultCurrency: "GBP", maxTasksPerProject: 3 }), {
      ...DEFAULT_CONFIG,
      defaultCurrency: "GBP",
      maxTasksPerProject: 3,
    });
    equal("resolveConfig without overrides is the default configuration", resolveConfig(), { ...DEFAULT_CONFIG });
    equal("the default configuration itself is unchanged", DEFAULT_CONFIG.notificationDigestBatchSize, 10);
    const overrides = { defaultCurrency: "JPY" };
    resolveConfig(overrides);
    equal("resolveConfig does not mutate the overrides it is given", overrides, { defaultCurrency: "JPY" });

    for (const size of [0, -1, 2.5, "3", null]) {
      await throws(
        `invalid batch size ${String(size)} rejects`,
        () => sendDigest(user, ["one"], { notificationDigestBatchSize: size }),
        RangeError,
      );
    }
    check("digest deliveries carry a message", typeof sendDigest(user, ["x"])[0]?.message === "string", "expected a message string");
  },

  // Prompt: discount applies to the base price first, tax applies to the discounted subtotal, the
  // subtotal floors at zero, and the total is rounded to two decimals.
  "discount-result-regression": async ({ importModule, equal, check, throws }) => {
    const { handleCheckout } = await importModule("src/api/billing-controller.mjs");
    const expected = (base, discount, taxRate) => {
      const reduction = discount.kind === "PERCENT" ? (base * discount.value) / 100 : discount.value;
      const subtotal = Math.max(0, base - reduction);
      return Math.round(subtotal * (1 + taxRate) * 100) / 100;
    };

    equal("percentage discount precedes tax", handleCheckout(120, { kind: "PERCENT", value: 10 }, 0.08), 116.64);
    equal("flat discount precedes tax and rounds cents", handleCheckout(95, { kind: "FLAT", value: 20 }, 0.075), 80.63);
    equal("discount cannot make subtotal negative", handleCheckout(30, { kind: "FLAT", value: 50 }, 0.2), 0);

    // The formula must hold for arbitrary valid inputs, not for the sampled ones.
    const disagreements = [];
    for (const base of [0, 15, 30, 99.99, 250, 1000]) {
      for (const discount of [
        { kind: "PERCENT", value: 0 },
        { kind: "PERCENT", value: 12 },
        { kind: "PERCENT", value: 100 },
        { kind: "FLAT", value: 0 },
        { kind: "FLAT", value: 20 },
        { kind: "FLAT", value: 5000 },
      ]) {
        for (const taxRate of [0, 0.05, 0.075, 0.2]) {
          const actual = handleCheckout(base, discount, taxRate);
          if (actual !== expected(base, discount, taxRate)) {
            disagreements.push(`base=${base} ${discount.kind}:${discount.value} tax=${taxRate} -> ${actual}, expected ${expected(base, discount, taxRate)}`);
          }
        }
      }
    }
    check(
      "checkout totals generalize across prices, discounts and tax rates",
      disagreements.length === 0,
      disagreements.slice(0, 5).join("; ") || "every combination matched the contract",
    );
    await throws("percentage over one hundred rejects", () => handleCheckout(100, { kind: "PERCENT", value: 101 }, 0), RangeError);
    await throws("negative percentage rejects", () => handleCheckout(100, { kind: "PERCENT", value: -1 }, 0), RangeError);
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
