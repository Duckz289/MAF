# subscription-price-mismatch

New subscriptions sometimes record an earlier plan price after the catalog has changed. A
subscription opened after a price update must capture the current price for that plan in
`priceAtSubscription`. Existing subscription records must remain unchanged when prices change
later, and unknown plans must still be rejected.

Fix the behavior for every plan and for repeated price changes. Preserve the billing-controller
API, the stored subscription shape, and unrelated reporting behavior.
