Product codes are supposed to be zero-padded on the *left* so their numeric value stays meaningful
(e.g. `7` padded to length 5 should read `"00007"`). Run `node bin/demo.mjs` to see the bug:
`padCode(7, 5)` currently prints `"70000"` instead.

Fix `padCode` in `src/codes.mjs` so it pads on the left instead of the right. A code that's already
at least `length` characters long must still be returned unchanged, exactly as it is now.
