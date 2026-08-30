# MAF Post-ed71448 Reconstruction Record

This is an explicit reconstruction from trusted base `ed7144853f5cf08be0d0ae98e676d10bbf95105d`. Historical SHAs were not recreated: `b2a5c31dbe6a4df2d7c1cec4f08d37a71099e788`, `65689daa459a17e8d295ebcd74404fc85d999126`, `187329ed7805750491bb38faff4efc4ab68b5097`. The recovered MAF directory remained read-only and was never executed.

- Reconstruction branch: `recovery/full-post-ed71448-reconstruction`
- Product: `PRODUCT_RECONSTRUCTION_CANDIDATE`; commit `33bebb699eae0c26718799d2788a1b6497855624`. Canonical expected-file containment, Windows path handling, symlink escape detection, regular-file checks, and deterministic failure precedence are covered by focused tests.
- Harness: commit `00c3fcb`; typed independent DVS, candidate/run validity, false-safe, paired outcomes, and unknown/partial cost semantics in `src/evaluation/`.
- Protocol: `evaluation/protocol.json`, version `2.0.0-reconstructed`; frontier execution disabled and fairness/leakage/invalid-run rules pre-registered.
- Phase B: `PHASE_B_RECONSTRUCTION_CANDIDATE`; commit `7822439`; 12 task concepts and 299 coherent public fixture fragments.
- Phase C: commit `7822439`; Band 1 = 5, Band 2 = 4, Band 3 = 5, with symptom-oriented IDs and orientation-audit requirements.

## Validation

`npm ci` PASS with unchanged lockfile. `node evaluation/validate-reconstruction.mjs` PASS. Focused product/evaluation tests PASS (14 tests). `npm run typecheck` PASS. Lint passes with existing warnings; `--error-on-warnings` remains nonzero due to historical test warnings. Repository-wide format check has pre-existing CRLF/formatter failures and unrelated files were not reformatted. Full post-final-commit build, smoke, compose, and validate were not rerun. No frontier benchmark was executed.

## Salvage, differences, and risks

Used only coherent public `.mjs` fragments and task names from the salvage reconstruction content. Rejected recovered product source, package metadata, corrupted protocol/manifests/graders, binary/NUL data, logs, private curator/reference/shortcut files, and agent patches as historical commits. No byte-equivalence, historical metrics, or frozen-suite identity is claimed. Complete hidden graders/references for every task, full local validation, and independent adversarial audit remain outstanding.

INDEPENDENT_AUDIT_REQUIRED: YES
