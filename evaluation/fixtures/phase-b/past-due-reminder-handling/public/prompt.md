# Keep accepted past-due reminders visible

`scheduleReminder(taskId, remindAt, now)` accepts both future and already-due reminders. Every
accepted reminder must appear in `listScheduled`; if `remindAt <= now`, it must also be returned by
`dueReminders(now)` immediately. Require a non-empty string task ID and finite numeric timestamps,
throwing `TypeError` otherwise. Preserve insertion order and return defensive list copies.
