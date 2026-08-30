# Fix duration carry across calendar boundaries

`addDuration(start, duration)` adds a non-negative integer number of minutes to a date-like `start`
value and returns a `Date`. It must preserve JavaScript's normal `Date` parsing behavior, reject an
invalid start with `RangeError`, and reject a negative, fractional, or non-numeric duration with
`TypeError`. Minute addition must carry through hours, days, months, and years rather than wrapping
inside the starting hour.
