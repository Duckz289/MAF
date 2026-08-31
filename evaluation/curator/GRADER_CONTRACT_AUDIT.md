# Grader contract audit

Every hidden grader in this suite was re-derived from its task's `public/prompt.md` during the
repair of independent-audit snapshot `bb326527`. This document records, per task, which assertions
the public contract justifies and which requirements were removed as hidden.

## Classification rules

| Class | Meaning | Action |
| --- | --- | --- |
| `PUBLICLY_JUSTIFIED` | The prompt states the requirement, or the visible repository already encodes it and the prompt says to preserve it. | Keep. |
| `AMBIGUOUS` | A reasonable implementer could satisfy the prompt either way. | Accept both, or make the prompt explicit. |
| `HIDDEN_REQUIREMENT` | The grader demanded something the prompt never stated. | Remove. |

A grader may **not** require any of the following unless the prompt says so: a particular reference
architecture, a particular file being changed, a particular helper, an exact internal call count, an
exact exception subclass, or exact whole-object equality where harmless extra fields are allowed.

## Hidden requirements removed

| Task | Removed requirement | Why it was hidden |
| --- | --- | --- |
| `inventory-orientation-task` | Fractional adjustments must throw `TypeError`. | The prompt says "reject any adjustment whose resulting quantity is negative or non-integer" and asks the implementer to "reuse the repository's quantity invariant where practical". That invariant, `assertValidQuantity`, throws `RangeError`. The grader rejected the implementation the prompt recommends. Now accepts `TypeError` or `RangeError`. |
| `b2-derived-aggregate-consistency` | Invalid `line.amount` must throw `TypeError`. | The prompt says only "reject invalid input". Now accepts `TypeError` or `RangeError`. |
| `b2-partial-validation-mutation` | Rejection type was already `Error`, but the valid path implicitly assumed a returned identity. | Now accepts `TypeError` or `RangeError` and checks the documented "may return a new record or mutate after validation" freedom explicitly. |
| `b2-order-refund-terminal-leak` | `NaN` refund amounts must reject. | Neither the prompt nor the visible `ledger.mjs` (`amount <= 0`) defines `NaN` as invalid. Removed; non-positive amounts are still required to reject. |
| `b2-record-shape-migration-loss` | Mutation was probed with a `Proxy`, which made `structuredClone` — a legitimate deep-copy strategy — throw. | Replaced with a non-writable input, which is invisible to any implementation that does not write to the input. |

## Under-specified assertions strengthened

These were not hidden requirements; they were assertions too weak to distinguish a correct
implementation from a behaviourally invalid one. Each is justified by the quoted prompt clause.

| Task | Clause | Strengthening |
| --- | --- | --- |
| `clamp-number-util` | "reject non-finite converted values with `TypeError`" (all three arguments) | Each argument position is probed with five non-finite values; clamping is swept against `min(max(v, lo), hi)`. |
| `duration-carry-fix` | "reject a negative, fractional, or non-numeric duration"; "carry through hours, days, months, and years" | Negative and non-numeric durations added; carry swept against epoch arithmetic. |
| `csv-export-feature` | "quote a field when it contains a comma, quote, carriage return, or newline" | Carriage return, header quoting, row order, trailing-newline and registry cases added. |
| `pagination-cursor-feature` | "Reject malformed/stale cursors" | Cursors are opaque, so staleness is probed encoding-agnostically: every string derived from a real cursor must either be rejected with `RangeError` or resolve to a genuine continuation. Silently restarting at the first page fails. Full-collection walk added. |
| `stale-cache-invalidation-bug` | "every later read for that user" | The same guarantee is exercised for a second user, so a single-id special case cannot pass. |
| `event-emitter-listener-leak` | "removes only that registration"; "must not ... remove unrelated listeners" | Three listeners are registered so `off` must remove exactly one; an unrelated event and an unrelated subscriber are checked too. |
| `inventory-orientation-task` | "Validation must happen before `saveItem`" | A pass-through probe over the store observes whether a rejected adjustment reached `saveItem` at all. Final-state equality alone cannot separate validate-first from save-then-restore. |
| `backward-compat-date-regression` | "treats both ends as inclusive" | Swept over ~1,000 range combinations against the inclusive definition. |
| `past-due-reminder-handling` | "Require ... finite numeric timestamps" (both declared timestamps) | The `now` parameter is validated alongside `remindAt`. |
| `report-output-path-boundary` | "Reject traversal, sibling-prefix tricks, and every other path that resolves outside `outDir`" | Candidate paths are generated systematically from prefix × tail × separator combinations and adjudicated by an independent `path.resolve` oracle, so both over-rejection and under-rejection fail. The workspace is diffed afterwards: no write may land outside `outDir`. No attack literal is special-cased. |
| `idempotency-key-race` | "exactly one caller may receive `true`"; "never be reserved" | Three concurrency widths, four independent keys, and concurrent contention on an audited key. |
| `webhook-retry-terminal-state` | "Retry 408, 425, 429, and 5xx" | Every documented status class is swept, including 408 and 425, plus recovery, mixed retryable sequences and a terminal status arriving mid-retry. |
| `b1-extend-exhaustive-union` | "returns the triangle's area (`0.5 * base * height`)" | Swept over 60 base/height pairs so the formula cannot be memorised from the demo's arguments. |
| `b2-bulk-op-tenant-bypass` | "A missing or foreign item must not be mutated" | The store is read back: an unknown id must remain absent, so reporting `NOT_FOUND` may not create a phantom record. Generalised to a second tenant. |
| `b2-order-refund-terminal-leak` | "only after the ledger call succeeds" | The injected ledger hook reads the order's status while it runs. Publishing `REFUNDED` before the ledger and rolling back is now visible. |
| `b2-partial-validation-mutation` | "must throw without changing any property of `record`" | Writes to the record are observed while the call runs, so mutate-then-restore fails. |
| `b2-record-shape-migration-loss` | "It must not mutate the input" | A non-writable input makes a transient write observable. |
| `b2-concurrent-seat-lost-update` | "never produce more successful bookings than available seats" | Five seat/contender ratios including the zero-seat case, distinct-user check, and cross-event independence. |
| `b2-pending-write-visibility` | "committing one must not publish another" | Three concurrent transactions, a pending overwrite of a committed key, and two independent stores. |
| `notification-settings-regression` | "A per-request override must win over the default for any configuration key" | Precedence is checked across three keys and through `resolveConfig`, so a single-key special case cannot pass. The prompt was made explicit about generality rather than the grader inferring it. |
| `discount-result-regression` | "Fix the behavior for arbitrary valid prices, discounts, and non-negative tax rates" | Swept over 144 price/discount/tax combinations against the stated formula. |
| `subscription-price-mismatch` | "Fix the behavior for every plan and for repeated price changes" | Seven subscriptions across three plans with repeated price changes; earlier records are re-read at the end. |
| `task-update-duplication` | "publish exactly one observable assignment update" | An independent subscriber on the event bus counts what is actually published, per transition, over six transitions and two interleaved tasks. This does not dictate *where* the duplicate emit is removed — the stored reference removes the command's emit and the stored alternative removes the service's — but a projection that discards half the events it receives fails. |
| `completion-state-regression` | "must atomically persist" | Persistence is checked through every repository read path (`get`, `listByProject`, `all`), so a terminal state synthesized inside one accessor fails. |

## Assertions deliberately not added

* `idempotency-key-race` / `b2-concurrent-seat-lost-update`: the prompts forbid "timing delays as
  synchronization", but detecting a `setTimeout` from outside would require inspecting the
  candidate's source. Only a coarse wall-clock bound is asserted. Recorded here rather than claimed
  as a synchronization-strategy check.
* `report-output-path-boundary`: the exact-`outDir` target (`writeReportFile(outDir, outDir, …)`) is
  excluded from the sweep. The prompt does not settle whether writing *to* the directory itself is
  contained, and the stored reference and the sweep oracle disagree on it. Grading an unsettled edge
  would be a hidden requirement.
