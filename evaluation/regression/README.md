# Independent-audit regression corpus

This directory holds candidate implementations used to measure **grader validity** rather than
candidate quality. It is separate from `evaluation/curator/**` on purpose: the curator overlays are
the suite's own instruments, and a suite must not be allowed to grade itself using only the
candidates it was tuned against.

Each candidate is stored as ordinary source files under
`candidates/<corpus>/<candidate-id>/<path-relative-to-the-public-repo>`, so that a reviewer reads
real code in a diff instead of an escaped JSON string. `index.json` carries the metadata and the
contract clause each candidate is meant to exercise.

## Corpora

| Corpus | Required status | Meaning |
| --- | --- | --- |
| `known-false-pass` | `FAIL` | Candidates the independent audit of `bb326527` showed were accepted despite violating the public contract. |
| `known-false-fail` | `PASS` | Contract-faithful candidates the same audit showed were rejected. |
| `fresh-false-pass` | `FAIL` | Contract-derived attacks authored during the repair, not copied from the audit. |
| `fresh-false-fail` | `PASS` | Structurally different correct implementations authored during the repair. |

### Independence

`fresh-false-pass` candidates are authored from the public prompt and from plausible coding-agent
mistakes, never from a grader's case literals. Each declares the `attackClass` it belongs to --
visible-example hard-code, partial status handling, one-id special casing, wrong-layer patch,
temporary mutation, over-broad locking, premature rounding, phantom record, and so on -- so the
corpus can be read as a survey of failure modes rather than a list of tricks.

`fresh-false-fail` candidates each declare the `freedom` they exercise: error-subclass freedom,
extra harmless fields, a different normalization strategy, a different locking primitive, a
different validation architecture, or a different ownership layer. A grader that rejects one of
these is encoding a hidden requirement.

A `known-false-pass` candidate that grades `PASS` is a **grader defect**, never a candidate defect:
every one of them is behaviourally wrong against the published prompt. Likewise a
`known-false-fail` candidate that grades `FAIL` means the grader encodes a hidden requirement the
prompt never stated.

## Running

```bash
node evaluation/run-audit-regression.mjs
```

Filter to one corpus with `--corpus known-false-pass`. The runner exits non-zero when any candidate
disagrees with its required status.

## Adding a candidate

1. Create `candidates/<corpus>/<id>/` and write the overlay files under it.
2. Add an entry to `index.json` with `phase`, `taskId` and a `contract` sentence quoting or closely
   paraphrasing the clause of `public/prompt.md` the candidate exercises.
3. Re-run the harness.

The `contract` field is the discipline that keeps this corpus honest: if you cannot point at a
public clause, the candidate does not belong in `known-false-pass`/`fresh-false-pass`, because
failing it would mean the grader is enforcing a hidden requirement.
