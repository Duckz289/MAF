# Keep report output inside its configured directory

`writeReportFile(outDir, requestedPath, content)` may accept a relative path or an absolute path that
resolves inside `outDir`. Resolve the target, create its parent directories, write UTF-8 content,
and return the resolved absolute path. Reject traversal, sibling-prefix tricks, and every other path
that resolves outside `outDir` with `RangeError`. A safely contained absolute path is legitimate and
must not be rejected merely for being absolute.
