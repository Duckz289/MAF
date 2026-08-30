export const phaseCBand3Graders = {
  "notification-settings-regression": async ({ importModule, equal, throws }) => {
    const { createUser } = await importModule("src/services/user-service.mjs");
    const { sendDigest } = await importModule("src/services/notification-service.mjs");
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
    equal(
      "default batch size remains ten",
      sendDigest(
        user,
        Array.from({ length: 11 }, (_, index) => String(index)),
      ).length,
      2,
    );
    equal(
      "different valid override generalizes",
      sendDigest(user, ["one", "two", "three", "four", "five"], {
        notificationDigestBatchSize: 2,
      }).length,
      3,
    );
    await throws(
      "invalid batch size rejects",
      () => sendDigest(user, ["one"], { notificationDigestBatchSize: 0 }),
      RangeError,
    );
  },
  "discount-result-regression": async ({ importModule, equal, throws }) => {
    const { handleCheckout } = await importModule("src/api/billing-controller.mjs");
    equal(
      "percentage discount precedes tax",
      handleCheckout(120, { kind: "PERCENT", value: 10 }, 0.08),
      116.64,
    );
    equal(
      "percentage discount generalizes across bases",
      handleCheckout(250, { kind: "PERCENT", value: 12 }, 0.05),
      231,
    );
    equal(
      "flat discount precedes tax and rounds cents",
      handleCheckout(95, { kind: "FLAT", value: 20 }, 0.075),
      80.63,
    );
    equal(
      "discount cannot make subtotal negative",
      handleCheckout(30, { kind: "FLAT", value: 50 }, 0.2),
      0,
    );
    await throws(
      "percentage over one hundred rejects",
      () => handleCheckout(100, { kind: "PERCENT", value: 101 }, 0),
      RangeError,
    );
  },
  "subscription-price-mismatch": async ({ importModule, equal, throws }) => {
    const { openSubscriptionAtPrice } = await importModule("src/bootstrap.mjs");
    const { subscriptionRepository } = await importModule(
      "src/repositories/subscription-repository.mjs",
    );
    const first = openSubscriptionAtPrice("user-a", "pro", 34.5);
    equal("new pro subscription captures current price", first.priceAtSubscription, 34.5);
    const basic = openSubscriptionAtPrice("user-b", "basic", 14.25);
    equal("behavior generalizes to another plan", basic.priceAtSubscription, 14.25);
    const later = openSubscriptionAtPrice("user-c", "pro", 39);
    equal("later update is used", later.priceAtSubscription, 39);
    equal("earlier record keeps captured price", first.priceAtSubscription, 34.5);
    equal(
      "repository stores the captured prices",
      subscriptionRepository.all().map((record) => record.priceAtSubscription),
      [34.5, 14.25, 39],
    );
    await throws(
      "unknown plans still reject",
      () => openSubscriptionAtPrice("user-d", "missing", 10),
      Error,
    );
  },
  "task-update-duplication": async ({ importModule, equal }) => {
    const { runAssignmentScenario } = await importModule("src/bootstrap.mjs");
    const { assignTaskCommand } = await importModule("src/commands/assign-task-command.mjs");
    const { getTaskAssignments } = await importModule(
      "src/projections/task-summary-projection.mjs",
    );
    const { taskRepository } = await importModule("src/repositories/task-repository.mjs");
    const first = runAssignmentScenario("project-a", "Investigate", "user-a");
    equal("one assignment produces one update", first.updates, [
      { userId: "user-a", taskId: first.task.id },
    ]);
    equal("assignment persists", taskRepository.get(first.task.id).assigneeId, "user-a");
    const before = getTaskAssignments().length;
    assignTaskCommand(first.task.id, "user-b");
    equal("reassignment produces one additional update", getTaskAssignments().slice(before), [
      { userId: "user-b", taskId: first.task.id },
    ]);
    equal("reassignment persists", taskRepository.get(first.task.id).assigneeId, "user-b");
  },
  "completion-state-regression": async ({ importModule, equal, throws }) => {
    const { runCompletionScenario } = await importModule("src/bootstrap.mjs");
    const { completeTaskCommand } = await importModule("src/commands/complete-task-command.mjs");
    const { getTaskCompletions } = await importModule(
      "src/projections/task-summary-projection.mjs",
    );
    const { taskRepository } = await importModule("src/repositories/task-repository.mjs");
    const first = runCompletionScenario("project-a", "Persist me");
    equal("completion result is terminal", first.completed.status, "COMPLETED");
    equal(
      "subsequent read is terminal",
      taskRepository.get(first.completed.id).status,
      "COMPLETED",
    );
    equal(
      "completion timestamp is persisted",
      taskRepository.get(first.completed.id).completedAt,
      first.completed.completedAt,
    );
    equal("one completion produces one update", first.updates, [
      { userId: null, taskId: first.completed.id },
    ]);
    const before = getTaskCompletions().length;
    await throws("missing task rejects", () => completeTaskCommand("missing-task"), Error);
    equal("failed completion emits no update", getTaskCompletions().length, before);
    const second = runCompletionScenario("project-b", "Another task");
    equal("arbitrary task IDs persist", taskRepository.get(second.completed.id), second.completed);
  },
};
