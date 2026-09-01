# notification-settings-regression

The support desk's morning digest ignores per-request settings. Run `node bin/demo.mjs`: the
console asks for a digest batch size of two across five subjects and should get three ordered
deliveries, but it gets one delivery containing everything, as though the workspace default were
still in force.

Per-request settings are supposed to take precedence over the workspace defaults for the duration
of that call. Restore that precedence. It must hold for **any** setting a caller overrides, not
only the one this report happens to mention, and a setting that is not overridden must keep its
workspace default. Do not change the workspace defaults themselves, and do not modify the settings
object a caller passes in.

Concretely, after the fix:

- `sendDigest(agent, subjects, settings)` must preserve subject order and group them using a
  positive integer `ticketDigestBatchSize`, rejecting any other value with `RangeError`. A call
  with no override must still use the workspace default of ten.
- `runEscalationSweep(settings)` must honour an `escalationAfterMinutes` override in the same way.
- `settingValue(key, overrides)` must return the caller's value for any overridden key and the
  workspace default for any key the caller did not override.

Preserve the existing public APIs, the delivery and ticket behaviour, and every unrelated setting.
