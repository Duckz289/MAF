# discount-result-regression

Freight quotes come out wrong when a percentage adjustment is applied. Run `node bin/demo.mjs`:
a base rate of 120 with 10% off and an 8% tax rate is quoted at 115.60, but the desk expects
116.64. The same lane with a flat 20 off is quoted correctly, so only the percentage case is
affected.

The quoting contract is:

- the adjustment comes off the base price first, and tax is then applied to what remains;
- a `PERCENT` adjustment is that percentage **of the base price**, and a `FLAT` adjustment is a
  currency amount;
- an adjustment may bring the subtotal down to zero but never below it;
- the quoted total is rounded to two decimal places.

Fix `quoteShipment(basePrice, adjustment, taxRate)` so it satisfies that contract for arbitrary
valid base prices, adjustments and non-negative tax rates — not only for the numbers in this
report. Keep the request validation as it is, including rejecting a percentage above one hundred
with `RangeError`, and do not change the separate code-based promotion behaviour.
