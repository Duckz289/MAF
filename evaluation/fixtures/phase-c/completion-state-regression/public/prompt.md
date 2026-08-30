# completion-state-regression

Completing a task returns a completed-looking object, but a subsequent read still reports the
task as open. A successful completion must atomically persist `status: "COMPLETED"` and a
non-null `completedAt`, return the persisted state, and publish exactly one completion update.
Completing a missing task must still reject without publishing an update.

Fix the behavior for arbitrary task IDs while preserving the command API, event payload shape,
and unrelated assignment behavior.
