# completion-state-regression

Completing a work order returns a completed-looking order, but the dispatch board does not agree.
Run `node bin/demo.mjs`: the completion reports `COMPLETED`, yet the board still counts zero
completed orders and leaves the order in its open column.

A successful completion must durably record `status: "COMPLETED"` and a non-null `completedAt` for
that order, return the recorded state, and publish exactly one completion update. Every later read
of that order — however the reader reaches it — must see the completed state. Completing an order
that does not exist must still reject, and must not publish an update.

Fix this for arbitrary work orders while preserving the command API, the event payload shape
(`orderId`, `technicianId` and `region`), and the unrelated assignment, scheduling and
technician-load behaviour.
