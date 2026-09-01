# Make idempotency reservation atomic across concurrent callers

`reserveKey(key)` may be asynchronous. Across concurrent calls for the same non-empty string key,
exactly one caller may receive `true`; all others receive `false`. A key already present in the
persistent audit log must never be reserved. Different keys must not block each other, and
`releaseKey(key)` must allow a later reservation when the audit log does not contain the key. Do
not use timing delays as synchronization; reserve deterministically before an asynchronous lookup
can let another caller enter.
