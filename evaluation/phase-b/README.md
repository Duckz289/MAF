# Reconstructed Phase B suite

Phase B is a newly authored 12-task behavioral corpus, not a recovered frozen suite. Each public
task contains only its prompt and candidate workspace. The matching hidden grader and curator
candidates live outside the public tree.

Every task is executed from a freshly materialized workspace. Acceptance requires the pristine and
known-wrong implementations to fail, the reference and independently structured alternative to
pass, the second-style attack to fail, and any generalization probe to pass. The suite also checks
repeatability, materialization, hidden isolation, and filename/content leakage without running a
frontier model.

Run Phase B directly with:

```text
npm run validate:evaluation:phase-b
```
