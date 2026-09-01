# Mirror the sibling title guard

Make `assertNonEmptyTitle(title)` follow `assertNonEmptyName`'s contract: reject a non-string or a
string that is empty after trimming with `RangeError`, otherwise return the trimmed string. Do not
change `assertNonEmptyName`.
