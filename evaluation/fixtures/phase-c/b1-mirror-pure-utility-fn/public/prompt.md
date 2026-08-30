`src/stats.mjs` exports `sumArray(values)`, which throws a `RangeError` on an empty array and
otherwise returns the sum. Running `node bin/demo.mjs` currently crashes with an import error
because it also needs an `averageArray(values)` export, which doesn't exist yet.

Add `averageArray(values)` to `src/stats.mjs`, mirroring `sumArray`'s style exactly: throw the same
`RangeError` on an empty array, and otherwise return the arithmetic mean of the values (reusing
`sumArray` to compute it). Don't change `sumArray`.
