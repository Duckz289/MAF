# Add cursor pagination

Change `listItemsPage(cursor, limit)` so `cursor` is either `null`/`undefined` for the first page or
the opaque cursor returned by the previous page. Return `{ items, nextCursor }`; `nextCursor` is a
string when more items remain and `null` on the final page. Cursors must continue from the item after
the last item previously returned and must not duplicate or skip items. Reject malformed/stale
cursors and non-integer limits outside 1–100 with `RangeError`. Preserve `addItem`.
