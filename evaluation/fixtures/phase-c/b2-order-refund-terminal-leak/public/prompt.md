# Do not publish a terminal refund state before the ledger accepts it

`processRefund(orderId, amount, ledgerRecordFn)` may set an order to `REFUNDED` only after the
ledger call succeeds. Missing orders and invalid amounts must still reject. If validation or the
injected asynchronous ledger function fails, the order must remain `PAID`. A successful call returns
the order in `REFUNDED` state.
