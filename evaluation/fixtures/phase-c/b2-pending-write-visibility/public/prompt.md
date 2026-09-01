# Do not expose a pending write until the commit hook completes

`createCommitStore()` returns independent store state. `begin(key, value)` creates a transaction but
must not change what `read(key)` returns. `commit(tx)` atomically makes that transaction's value
visible. Multiple pending transactions for different keys must remain invisible until each is
committed, and committing one must not publish another.
