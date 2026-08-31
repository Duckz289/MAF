const scheduled = [];

export function scheduleReminder(taskId, remindAt, now = Date.now()) {
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new TypeError("taskId must be a non-empty string");
  }
  if (typeof remindAt !== "number" || !Number.isFinite(remindAt)) {
    throw new TypeError("remindAt must be a finite number");
  }
  const entry = { taskId, remindAt };
  scheduled.push(entry);
  return { ...entry };
}

export function listScheduled() {
  return scheduled.map((entry) => ({ ...entry }));
}

export function dueReminders(now = Date.now()) {
  return scheduled.filter((entry) => entry.remindAt <= now).map((entry) => ({ ...entry }));
}
