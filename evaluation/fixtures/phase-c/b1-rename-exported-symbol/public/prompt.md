Running `node bin/demo.mjs` currently crashes with an import error: `src/index.mjs` and
`src/receipt.mjs` both expect `src/id-utils.mjs` to export a function named `formatDisplayId`, but
`src/id-utils.mjs` exports the same function under a different name.

Rename the exported function in `src/id-utils.mjs` to `formatDisplayId` so both `src/index.mjs`'s
re-export and `src/receipt.mjs`'s import resolve correctly. Don't change what the function does,
just its exported name.
