# MAF Post-ed71448 Reconstruction Record

This is an explicit reconstruction from trusted base `ed7144853f5cf08be0d0ae98e676d10bbf95105d`. Historical SHAs were not recreated: `b2a5c31dbe6a4df2d7c1cec4f08d37a71099e788`, `65689daa459a17e8d295ebcd74404fc85d999126`, `187329ed7805750491bb38faff4efc4ab68b5097`. The recovered MAF directory remained read-only and was never executed.

- Branch: `recovery/full-post-ed71448-reconstruction`
- Product: `PRODUCT_RECONSTRUCTION_CANDIDATE`; commit `33bebb699eae0c26718799d2788a1b6497855624`.
- Harness: commit `00c3fcb`; independent DVS, candidate/run validity, false-safe, paired outcomes, and unknown/partial cost semantics in `src/evaluation/`.
- Protocol: `evaluation/protocol.json`, version `2.0.0-reconstructed`; frontier execution disabled.
- Phase B: `PHASE_B_RECONSTRUCTION_CANDIDATE`; commit `7822439`; 12 task concepts and 299 coherent public fixture fragments. Completion checkpoint `fe14daa` adds the missing `duration-carry-fix` public fixture, bringing the filesystem to 12 fixture directories.
- Phase C: completion checkpoint `fe14daa` expands the manifest to Band 1 = 5, Band 2 = 7, Band 3 = 5. The three newly added Band 2 public seeds are `b2-partial-validation-mutation`, `b2-derived-aggregate-consistency`, and `b2-pending-write-visibility`.
- Final validator fix: commit `c2dfcf4` (`fix(evaluation): resolve Windows validator path`).

## Validation

`npm ci` PASS with unchanged lockfile. `node evaluation/validate-reconstruction.mjs` PASS: protocol 2.0.0-reconstructed, Phase B 12, Phase C 5/7/5. `node evaluation/validate-fixtures.mjs` PASS: 29 public materializations, hidden isolation, leakage scan, and deterministic policy checks. Focused product/evaluation tests PASS: 2 files, 14 tests. The post-completion full suite PASS: 83 files passed, 4 skipped; 1094 tests passed, 8 skipped. `npm run typecheck` PASS. `npm run build` PASS. `npm run lint` PASS with 14 existing warnings and 6 infos; no new fixture errors. Repository-wide format check retains pre-existing CRLF/formatter failures; unrelated files were not reformatted. Smoke/compose and independent adversarial/reference grader execution remain unsupported because this reconstructed tree has no curator grader corpus or runner. No Native/MAF frontier benchmark was executed.

## Context-orientation audit

Band 3 review: `b3-config-provider-boundary-trace`, `b3-dead-code-vs-live-discount-path`, `b3-decoy-cache-source-of-truth`, `b3-duplicate-service-owner`, and `b3-event-handler-owner-trace` are `CONTEXT_TEST_STRONG`. Their IDs describe symptoms, public prompts do not name implementation owners, and each seed contains meaningful decoy modules and traversal context. No Band 3 task is `NOT_A_CONTEXT_TEST`.
## Salvage and uncertainty

Used only coherent public `.mjs` fragments and task names from the salvage reconstruction content. Rejected recovered product source, package metadata, corrupted protocol/manifests/graders, binary/NUL data, logs, private curator/reference/shortcut files, and agent patches as historical commits. No byte-equivalence, historical metrics, or frozen-suite identity is claimed. Complete hidden graders/references for every task, full local validation, and independent adversarial audit remain outstanding.

INDEPENDENT_AUDIT_REQUIRED: YES
