# Add a numeric clamp utility

Export `clampNumber(value, min, max)` from `src/number-utils.mjs`. Convert all three arguments with
JavaScript's `Number(...)` conversion, reject non-finite converted values with `TypeError`, and
reject `min > max` with `RangeError`. Otherwise return the converted value limited to the inclusive
`[min, max]` range. This means ordinary JavaScript conversion behavior is part of the contract (for
example, `Number(null) === 0`). Preserve the existing `roundTo` and `isInRange` APIs and correct
`roundTo` so its decimal-place argument is applied before rounding.
