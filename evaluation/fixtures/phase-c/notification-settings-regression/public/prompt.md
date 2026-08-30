# notification-settings-regression

Digest delivery ignores request-level settings. For example, five items requested with a batch
size of two must produce three ordered deliveries, but the application behaves as though the
default batch size were still active.

Restore request-level configuration precedence without changing the default configuration.
`sendDigest(user, items, settings)` must preserve item order, use a positive integer
`notificationDigestBatchSize`, and leave both the items and settings objects unchanged. Calls
without a batch-size override must continue to use the default of ten. Preserve existing public
APIs and unrelated configuration values.
