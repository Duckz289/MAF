# Reject invalid input before mutating durable state

`applyPatch(record, patch)` accepts only status values `"open"` and `"closed"`. A missing patch,
missing/non-string status, or any other status must throw without changing any property of `record`.
A valid patch must produce the requested status while preserving unrelated record fields. The
implementation may return a new record or mutate after all validation has succeeded.
