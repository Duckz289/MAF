# subscription-price-mismatch

Memberships opened after a price change still record the old price. Run `node bin/demo.mjs`: the
desk moves the `standard` plan to 39 and enrols Bo immediately afterwards, but Bo's membership is
recorded at 34.99 — the same figure as Ada's, who enrolled before the change.

A membership must capture the price that is in force for that plan at the moment it is opened, and
store it as `rateAtEnrolment`. Memberships opened earlier must keep the price they captured when a
plan's price changes later, and a plan the club does not offer must still be rejected with
`RangeError`.

Fix this for every plan and for repeated price changes, not just the one in this report. Preserve
the front-desk and enrolment APIs, the stored membership shape (`memberId`, `planId`,
`rateAtEnrolment`), and the unrelated roster, statement and access behaviour.
