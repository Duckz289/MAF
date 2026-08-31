# notification-settings-regression

Digest delivery ignores request-level settings. For example, five items requested with a batch
size of two must produce three ordered deliveries, but the application behaves as though the
default batch size were still active.

Restore request-level configuration precedence. A per-request override must win over the default
for **any** configuration key, not only the one this report mentions, and a key that is not
overridden must keep its default value. Do not change the default configuration itself, and do not
mutate the caller's settings object.

`sendDigest(user, items, settings)` must preserve item order, use a positive integer
`notificationDigestBatchSize`, rejecting any other value with `RangeError`, and leave both the items
and settings objects unchanged. Calls without a batch-size override must continue to use the default
of ten. Preserve existing public APIs and unrelated configuration values.
