import { scheduleReminder, dueReminders } from "../src/reminder-scheduler.mjs";

const now = 1000000;
try {
  const result = scheduleReminder("demo-reminder", now - 5000, now);
  const isDue = dueReminders(now).some((r) => r.taskId === "demo-reminder");
  console.log(`scheduled without throwing: ${JSON.stringify(result)}; immediately due: ${isDue}`);
} catch (error) {
  console.log(`rejected past-due reminder: ${error.message}`);
}
