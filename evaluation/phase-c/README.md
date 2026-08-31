# Reconstructed Phase C research suite

Phase C is newly authored research material, not a recovered benchmark result. It contains three
executable behavioral bands while prohibiting frontier execution during local validation.

- Band 1 has five focused local-change tasks.
- Band 2 has seven multi-file assurance tasks covering authorization, concurrency, transaction
  ordering, shape preservation, validation atomicity, derived state, and write visibility.
- Band 3 has five symptom-named context-tracing tasks. Each requires at least three meaningful
  reasoning hops and includes plausible decoys without naming the implementation owner in its ID or
  public prompt.

The Band 3 orientation audit measures each task rather than reading a stored classification, and
its current result is **3 `CONTEXT_TEST_STRONG`, 2 `CONTEXT_TEST_WEAK`, 0 `NOT_A_CONTEXT_TEST`**.
The two weak tasks -- `task-update-duplication` and `completion-state-regression` -- sit one hop
below the declared investigation-depth threshold and are reported weak rather than reclassified.
Run `node evaluation/audit-band3-context.mjs` for the current numbers; the report carries the
thresholds it applied, so its verdict can be re-derived or disputed on the evidence.
Private graders, correct candidates, wrong candidates, attacks, probes, shortcuts, and curator notes
remain outside public workspaces.

Run Bands 1 and 2 with `npm run validate:evaluation:phase-c:band12`; run Band 3 and its context audit
with `npm run validate:evaluation:phase-c:band3`.
