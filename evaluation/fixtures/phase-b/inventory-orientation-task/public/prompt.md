# Preserve inventory quantity invariants during adjustments

`restockItem(sku, additionalQuantity)` accepts an integer signed adjustment, including a negative
adjustment when stock remains available. It must reject a missing item and reject any adjustment
whose resulting quantity is negative or non-integer. Validation must happen before `saveItem`, so a
rejected adjustment leaves the stored item unchanged. Reuse the repository's quantity invariant
where practical and keep `addItem` behavior intact.
