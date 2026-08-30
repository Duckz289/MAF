# discount-result-regression

Checkout totals are wrong for percentage discounts. The checkout contract applies the discount
to the base price first, then applies tax to the discounted subtotal. `PERCENT` values are a
percentage of the base price; `FLAT` values are currency amounts. A discount may reduce the
subtotal to zero but never below it, and the final total is rounded to two decimal places.

Fix the behavior for arbitrary valid prices, discounts, and non-negative tax rates. Preserve the
existing command and controller APIs and do not change the separate code-based promotion
compatibility behavior.
