# MAF Post-ed71448 Reconstruction Record

This is an explicit reconstruction from trusted base `ed7144853f5cf08be0d0ae98e676d10bbf95105d`. Historical SHAs were not recreated: `b2a5c31dbe6a4df2d7c1cec4f08d37a71099e788`, `65689daa459a17e8d295ebcd74404fc85d999126`, `187329ed7805750491bb38faff4efc4ab68b5097`. The recovered MAF directory remained read-only and was never executed.

- Branch: `recovery/full-post-ed71448-reconstruction`
- Product: `PRODUCT_RECONSTRUCTION_CANDIDATE`; commit `33bebb699eae0c26718799d2788a1b6497855624`.
- Harness: commit `00c3fcb`; independent DVS, candidate/run validity, false-safe, paired outcomes, and unknown/partial cost semantics in `src/evaluation/`.
- Protocol: `evaluation/protocol.json`, version `2.0.0-reconstructed`; frontier execution disabled.
- Phase B: `PHASE_B_RECONSTRUCTION_CANDIDATE`; commit `7822439`; 12 task concepts and 299 coherent public fixture fragments.
- Phase C: commit `7822439`; Band 1 = 5, Band 2 = 4, Band 3 = 5.
- Final validator fix: commit `c2dfcf4` (`fix(evaluation): resolve Windows validator path`).

## Validation

`npm ci` PASS with unchanged lockfile. `node evaluation/validate-reconstruction.mjs` PASS: protocol 2.0.0-reconstructed, Phase B 12, Phase C 5/4/5. Focused product/evaluation tests PASS: 2 files, 14 tests. `npm run typecheck` PASS. Lint runs but existing warnings remain; `--error-on-warnings` is nonzero because of historical test warnings. Repository-wide format check has pre-existing CRLF/formatter failures; unrelated files were not reformatted. Full post-final-commit build, smoke, compose, and `validate` were not rerun. No Native/MAF frontier benchmark was executed.

## Salvage and uncertainty

Used only coherent public `.mjs` fragments and task names from the salvage reconstruction content. Rejected recovered product source, package metadata, corrupted protocol/manifests/graders, binary/NUL data, logs, private curator/reference/shortcut files, and agent patches as historical commits. No byte-equivalence, historical metrics, or frozen-suite identity is claimed. Complete hidden graders/references for every task, full local validation, and independent adversarial audit remain outstanding.

INDEPENDENT_AUDIT_REQUIRED: YES
