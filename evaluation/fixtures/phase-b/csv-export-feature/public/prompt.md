# Add CSV report export

Make `writeReport(report, "csv")` return CSV text whose first row is `report.columns` and whose
remaining rows are `report.rows`, preserving their order. Convert `null` and `undefined` cells to
empty fields and other values with `String`. Quote a field when it contains a comma, quote, carriage
return, or newline; inside a quoted field, double each quote. Join records with `\n` and do not add a
trailing newline. Keep JSON output and the formatter registry API working.
