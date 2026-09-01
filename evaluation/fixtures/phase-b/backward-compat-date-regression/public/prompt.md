# Restore inclusive date-range overlap behavior

Add the missing `src/date-range.mjs`. `overlapDays(aStart, aEnd, bStart, bEnd)` receives integer day
indexes, treats both ends as inclusive, and returns the number of shared days. Touching ranges
therefore overlap by one day and disjoint ranges return zero. Reject a non-integer input with
`TypeError` and a range whose start is after its end with `RangeError`. Keep the four-positional-
argument API used by existing callers.
