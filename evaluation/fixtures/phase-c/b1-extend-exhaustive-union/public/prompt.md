`computeArea` in `src/shape-area.mjs` handles `"circle"`, `"square"`, and `"rectangle"` shapes.
Run `node bin/demo.mjs` to see it throw `RangeError: Unknown shape kind: triangle` on the second
line -- we need it to also handle `"triangle"` shapes, given as `{ kind: "triangle", base, height }`.

Add a `"triangle"` case to the switch, matching the existing style, that returns the triangle's
area (`0.5 * base * height`). Don't change how the existing shape kinds are computed or how an
unknown kind is rejected.
