# Keep derived totals consistent after each accepted mutation

`addLine(state, line)` returns a new cart state containing the existing lines plus a copy of `line`.
The returned `total` must equal the sum of every line amount, including pre-existing lines. Require
`line.amount` to be a finite number and reject invalid input without mutating the original state.
