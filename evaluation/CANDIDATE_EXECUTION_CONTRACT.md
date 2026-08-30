# Reconstructed Candidate Execution Contract

**Status: NEWLY_AUTHORED_RECONSTRUCTION.** The historical task ABI and private corpus are lost; this document defines a new local-only contract.

Each task's `public/` directory is the pristine seed. A candidate is an explicit file overlay directory under the private curator workspace. Overlay paths are relative to the task's public repository root; copying a file replaces the corresponding seed file. The runner never copies private files into a candidate workspace.

A hidden grader is a private executable invoked as `node grader.mjs --workspace <absolute-path>`. It must emit one JSON object on stdout with `status` equal to `PASS` or `FAIL`. Crashes, malformed output, missing workspace, missing entrypoint, failed materialization, and private-file leakage are `INVALID`, never pass.

Each case gets a fresh temporary workspace and fresh child process. Candidate overlays are applied before the child process starts. The pristine seed is never modified. Private grader/reference/candidate/curator paths are outside the workspace and are not on the candidate process's search path. Temporary paths are scoped to the current task and removed only after the case completes.

The ABI result is `{taskId, candidate, status, evidence}` where status is `PASS`, `FAIL`, or `INVALID`. Determinism repeats the complete case in fresh processes and requires identical statuses and normalized evidence. Frontier models are outside this contract and are never invoked by the local runner.

## Structured grader protocol

The generic runner invokes each private grader as `node grader.mjs --workspace <absolute-path>`. The grader emits exactly one JSON object with `status` (`PASS`, `FAIL`, or `INVALID`), a `checks` array of `{name, passed, message}`, and a diagnostic `message`. The runner validates this schema; nonzero exit, missing grader, malformed JSON, unknown status, missing checks, or leaked private files become `INVALID`.
