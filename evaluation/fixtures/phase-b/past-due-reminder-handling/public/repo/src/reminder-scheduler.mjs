const scheduled = [];

export function scheduleReminder(taskId, remindAt, now = Date.now()) {
  const entry = { taskId, remindAt };
  if (remindAt > now) {
    scheduled.push(entry);
  }
  return entry;
}

export function listScheduled() {
  return [...scheduled];
}

export function dueReminders(now = Date.now()) {
  return scheduled.filter((r) => r.remindAt <= now);
}
