const scheduled = [];

export function scheduleReminder(taskId, remindAt, now = Date.now()) {
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new TypeError("taskId must be a non-empty string");
  }
  for (const [label, value] of [
    ["remindAt", remindAt],
    ["now", now],
  ]) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`${label} must be a finite number`);
    }
  }
  const entry = { taskId, remindAt };
  scheduled.push(entry);
  return { ...entry };
}

export function listScheduled() {
  return scheduled.map((entry) => ({ ...entry }));
}

export function dueReminders(now = Date.now()) {
  const due = scheduled.filter((entry) => entry.remindAt <= now);
  // Skips the allocation when nothing was filtered out.
  return due.length === scheduled.length ? scheduled : due;
}
