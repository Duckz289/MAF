# Stop event listeners cleanly

Add the missing `createEventBus()` implementation. Its `on(eventName, listener)` method registers
that listener and returns an idempotent stop function that removes only that registration. `emit`
must call the listeners currently registered for the event, and `off(eventName, listener)` must also
be available. Starting and stopping metrics/audit subscribers repeatedly must not accumulate old
listeners or remove unrelated listeners.
