# Prevent concurrent seat bookings from losing updates

Add the missing `src/seat-inventory.mjs`. `seedEvent(id, available)` creates an event with an empty
`bookedBy` list. `bookSeat(eventId, userId, auditFn)` returns a promise for `true` only when it
atomically claims one available seat, otherwise `false`. Concurrent calls must never produce more
successful bookings than available seats; `available` and `bookedBy` must agree after completion.
The supplied asynchronous audit hook may yield, so the claim must be synchronized without timing
delays. `getEvent` returns the current event.
