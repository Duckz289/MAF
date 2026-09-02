// Immutable identities the Scoring Runner consumes but never defines.
//
// Protocol v2 is frozen at a git tag. This runner is a SEPARATE artifact that reads that frozen
// design and executes it; nothing in this file may be edited to "fix" a frozen value. If one of
// these constants disagrees with the repository, the correct response is to stop, not to update the
// constant -- that is the entire point of pinning them here rather than reading them from mutable
// working-tree files.

/** Frozen 29-task benchmark suite. */
export const SUITE_TAG = "maf-suite-freeze-v1";
export const SUITE_SHA = "92f13ae67802dd0049ca001f70839a9451120900";

/** Protocol v1: pre-registered experimental design (arms, metrics, N, stats plan). */
export const PROTOCOL_V1_TAG = "maf-experiment-protocol-v1";
export const PROTOCOL_V1_SHA = "b183b20a08b1d4f6902bffea49fe139f80cad4e9";

/** Protocol v2: real-provider execution plumbing over the identical v1 design. */
export const PROTOCOL_V2_TAG = "maf-experiment-protocol-v2";
export const PROTOCOL_V2_SHA = "b086b21e1e66f4a3c039d5c60079d9311eb82e15";

/**
 * Analysis v1: the pre-scoring statistical specification.
 *
 * This is the fourth frozen input, and it is load-bearing for exactly the reason the others are.
 * The scoring-readiness audit found three genuine gaps in Protocol v1/v2's statistical plan
 * (majority-of-3 under reduced N, the McNemar variant, and which Wilson-based difference method).
 * Analysis v1 resolves them BEFORE any scoring data exists, which is what keeps the resolution a
 * pre-registration rather than a choice fitted to observed results. A scoring record that cannot
 * name the analysis specification it was collected under is not reproducible, so every campaign
 * requires this tag exactly as it requires the suite and the protocol.
 */
export const ANALYSIS_TAG = "maf-experiment-analysis-v1";
export const ANALYSIS_SHA = "de02da424e8d639213cf03aadfd9566ab3313adb";
export const ANALYSIS_VERSION = "1.0.0";

/**
 * The tag that must exist and point at the executing source revision before ANY billed scoring
 * call is permitted (mission Phase 15). It deliberately does not exist yet: until an independent
 * audit creates it, `execution-gate.ts` cannot authorize a provider invocation, which is what makes
 * "provider calls are impossible during development" a structural property rather than a promise.
 */
export const RUNNER_TAG = "maf-scoring-runner-v1";
export const RUNNER_VERSION = "1.0.0";

/**
 * Frozen experimental parameters, mirrored here ONLY so the runner can assert that the manifest it
 * loaded still agrees with them. The manifest remains the source of truth; a disagreement is a
 * hard stop (see `execution-gate.ts`), never a silent preference for either side.
 */
export const FROZEN_PARAMETERS = {
  model: "claude-sonnet-5",
  provider: "anthropic",
  effort: "high",
  timeoutMs: 1_800_000,
  perRunCeilingUsd: 8,
  taskCount: 29,
  runsPerTask: 3,
  totalScoringRuns: 174,
  randomizationSeed: "maf-experiment-protocol-v1-native-vs-maf-2026-09-01",
} as const;

/**
 * Protocol v2's own source metadata still reads `PRE_REGISTERED_NOT_FROZEN` at the frozen commit,
 * because the freeze was performed by creating an immutable git tag over that commit rather than by
 * editing prose inside it. Rewriting the commit to make the wording agree would have changed the
 * SHA the tag exists to protect.
 *
 * The tag is therefore the freeze authority, and this discrepancy is recorded as a known,
 * non-blocking note on every scoring report rather than being quietly resolved either way.
 */
export const PROTOCOL_FREEZE_AUTHORITY = "GIT_TAG" as const;
export const KNOWN_SOURCE_METADATA_NOTE =
  `The frozen Protocol v2 commit ${PROTOCOL_V2_SHA} contains source metadata reading ` +
  '"PRE_REGISTERED_NOT_FROZEN" (evaluation/experiments/native-vs-maf-v2.json status, ' +
  "EXPERIMENT_PROTOCOL_V2.md header). That metadata predates the freeze ceremony: the protocol was " +
  `frozen by creating the immutable tag ${PROTOCOL_V2_TAG} over that exact commit, and editing the ` +
  "prose would have changed the very SHA the tag protects. protocolFreezeAuthority=GIT_TAG and " +
  "protocolFrozen=true are authoritative; this note is informational and never blocks execution.";
