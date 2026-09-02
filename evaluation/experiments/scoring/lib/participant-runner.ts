// Executes one paired scoring observation using the ALREADY-AUDITED Protocol v2 primitives.
//
// Nothing here re-implements execution semantics. The run ledger, attempt driver, failure
// classification, model provenance, cost accounting, workspace isolation and independent verifier
// are used exactly as Protocol v2 froze them; this module's whole job is to bracket one
// `ExperimentRunController.runPair` call with the durable state machine the campaign needs.
//
// EXECUTION UNIT vs IDENTITY UNIT. The campaign's identity and statistics unit is the per-arm
// RunSlot (87 NATIVE + 87 MAF = 174). The audited execution primitive, however, runs a PAIR --
// `BenchmarkRunner.compare` produces the paired evaluation both arms are scored from, and the
// frozen randomization specifies arm order WITHIN a task. So execution proceeds pair-wise (87
// paired executions) while identity stays per-slot. Splitting the pair to force a per-arm execution
// path would duplicate exactly the semantics Phase 7 says not to duplicate.
//
// ORDER OF OPERATIONS around money, which is the part that must not be rearranged:
//
//   1. claim BOTH slots            -- exclusive create; if either is unavailable, nothing spawns
//   2. build workspaces, prove parity of the starting state
//   3. declare provider-start intent for BOTH arms, flushed to disk
//   4. runPair()                   -- the only step that can spend money
//   5. record attempt outcomes     -- resolves the ambiguity the intents opened
//   6. append observations         -- append-only, never overwritten
//
// A crash between 3 and 5 leaves an intent with no outcome, which the state store reports as
// RECOVERY_REQUIRED and refuses to retry automatically. That is the intended behaviour, not a gap.

import path from "node:path";
import { CuratorIndependentVerifier } from "../../../../src/evaluation/curator-verifier";
import { ExperimentRunController } from "../../real/lib/experiment-run-controller";
import type { ExperimentProvenanceRecord } from "../../real/lib/provenance";
import {
  ANALYSIS_SHA,
  ANALYSIS_TAG,
  ANALYSIS_VERSION,
  FROZEN_PARAMETERS,
  KNOWN_SOURCE_METADATA_NOTE,
  PROTOCOL_V2_SHA,
  PROTOCOL_V2_TAG,
  RUNNER_TAG,
  RUNNER_VERSION,
  SUITE_SHA,
  SUITE_TAG,
} from "./frozen-refs";
import type { Arm, RunSlot } from "./schedule";
import { assertAuthorizedForPair, type ProviderAuthorization } from "./execution-gate";
import { assertScoringEligible, type ScoringProvenanceRecord } from "./scoring-provenance";
import { captureSourceRevision, assertStartingStateParity } from "./source-revision";
import type { ScoringStateStore } from "./state-store";

/**
 * argv every scoring spawn must contain. The first billed preflight recorded `effort: high` in
 * provenance while never emitting `--effort`, so the controlled variable was declared but not
 * enforced. These are checked against the argv the adapter ACTUALLY spawned.
 */
export const REQUIRED_SPAWN_ARGS: ReadonlyArray<readonly [string, string]> = [
  ["--model", FROZEN_PARAMETERS.model],
  ["--effort", FROZEN_PARAMETERS.effort],
];

export interface SpawnArgvCheck {
  ok: boolean;
  observedArgs: string[] | null;
  missing: string[];
  detail: string;
}

/** Proves a recorded spawn actually carried the frozen controlled variables. */
export const verifySpawnArgv = (record: ExperimentProvenanceRecord): SpawnArgvCheck => {
  const started = record.attempts.filter((attempt) => attempt.started);
  if (started.length === 0) {
    return {
      ok: false,
      observedArgs: null,
      missing: REQUIRED_SPAWN_ARGS.map(([flag]) => flag),
      detail: "no attempt was started, so no argv was observed",
    };
  }
  const missing: string[] = [];
  let observedArgs: string[] | null = null;
  for (const attempt of started) {
    const args = attempt.spawn?.args ?? null;
    observedArgs = args;
    if (!args) {
      missing.push("(argv not observed)");
      continue;
    }
    for (const [flag, expected] of REQUIRED_SPAWN_ARGS) {
      const index = args.indexOf(flag);
      if (index === -1 || args[index + 1] !== expected) {
        missing.push(`${flag} ${expected}`);
      }
    }
  }
  return {
    ok: missing.length === 0,
    observedArgs,
    missing,
    detail:
      missing.length === 0
        ? `spawn argv carried ${REQUIRED_SPAWN_ARGS.map(([f, v]) => `${f} ${v}`).join(" and ")}`
        : `spawn argv is missing the frozen controlled variable(s): ${[...new Set(missing)].join(", ")}`,
  };
};

export interface PairedSlotPair {
  native: RunSlot;
  maf: RunSlot;
}

export interface ParticipantRunnerConfig {
  repoRoot: string;
  store: ScoringStateStore;
  frozenTaskIds: readonly string[];
  /** Resolved once by the gate and reused verbatim, so the audited binary is the executed binary. */
  claudeCommand?: string;
  runnerSha: string | null;
  /** Campaign this execution belongs to; the authorization is bound to it. */
  campaignId: string;
  /** Schedule the pair was drawn from; the authorization is bound to it. */
  scheduleDigest: string;
  /** Directory holding the frozen suite's pristine task fixtures. */
  fixtureRootResolver: (taskId: string) => string;
  /** Locates a task's hidden grader phase for the independent verifier. */
  verifierLocate: (taskId: string) => { phase: string; taskId: string } | null;
  /** Injection point for tests; defaults to the real controller. */
  controllerFactory?: (
    config: ConstructorParameters<typeof ExperimentRunController>[0],
  ) => ExperimentRunController;
}

export type PairedExecutionResult =
  | {
      status: "EXECUTED";
      nativeProvenance: ScoringProvenanceRecord;
      mafProvenance: ScoringProvenanceRecord;
      argv: { native: SpawnArgvCheck; maf: SpawnArgvCheck };
    }
  | { status: "REFUSED"; reason: string; detail: string };

const buildScoringProvenance = (input: {
  base: ExperimentProvenanceRecord;
  slot: RunSlot;
  generation: number;
  attemptId: string;
  runnerSha: string | null;
  sourceRevision: Awaited<ReturnType<typeof captureSourceRevision>>;
}): ScoringProvenanceRecord => ({
  ...input.base,
  scoringStatus: "SCORING",
  protocolTag: PROTOCOL_V2_TAG,
  protocolSha: PROTOCOL_V2_SHA,
  suiteTag: SUITE_TAG,
  suiteSha: SUITE_SHA,
  runner: {
    runnerVersion: RUNNER_VERSION,
    runnerTag: RUNNER_TAG,
    runnerSha: input.runnerSha,
  },
  analysis: {
    analysisTag: ANALYSIS_TAG,
    analysisSha: ANALYSIS_SHA,
    analysisVersion: ANALYSIS_VERSION,
  },
  slot: {
    slotId: input.slot.slotId,
    slotDigest: input.slot.slotDigest,
    taskId: input.slot.taskId,
    arm: input.slot.arm,
    replicate: input.slot.replicate,
    randomizationPosition: input.slot.randomizationPosition,
    sequencePosition: input.slot.sequencePosition,
    generation: input.generation,
    attemptId: input.attemptId,
  },
  sourceRevision: input.sourceRevision,
  protocolFreezeAuthority: "GIT_TAG",
  protocolFrozen: true,
  knownSourceMetadataNote: KNOWN_SOURCE_METADATA_NOTE,
  recoveryState: "CLEAN",
});

/**
 * Runs one task+replicate pair end to end under the durable state machine.
 *
 * Returns REFUSED (without spawning anything) whenever either slot is unavailable. Both slots must
 * be claimable before any intent is declared, because a pair whose arms were collected under
 * different conditions is not a paired observation.
 */
export const executePairedSlots = async (
  config: ParticipantRunnerConfig,
  pair: PairedSlotPair,
  options: {
    prompt: string;
    expectedVerification: string;
    /**
     * Capability minted by a complete execution-gate evaluation. REQUIRED: this is the provider
     * boundary, and it enforces authorization itself rather than trusting that some earlier caller
     * did. There is no second spawn entrypoint that skips this.
     */
    authorization: ProviderAuthorization;
  },
): Promise<PairedExecutionResult> => {
  const { store } = config;

  // 0. Authorization FIRST, bound to this exact campaign, schedule and pair. A capability issued
  //    for a different pair -- or a stale one from before the budget moved -- is refused here,
  //    before any claim, workspace or spawn.
  assertAuthorizedForPair(options.authorization, {
    campaignId: config.campaignId,
    scheduleDigest: config.scheduleDigest,
    nativeSlotDigest: pair.native.slotDigest,
    mafSlotDigest: pair.maf.slotDigest,
  });

  // Membership: a NON_SCORING or out-of-suite task must never reach an executor, let alone a paid
  // one.
  for (const slot of [pair.native, pair.maf]) {
    assertScoringEligible({
      taskId: slot.taskId,
      scoringStatus: "SCORING",
      frozenTaskIds: config.frozenTaskIds,
    });
  }

  // 1. Claim BOTH slots before anything can spawn.
  const nativeClaim = await store.claimSlot(pair.native);
  if (!nativeClaim.claimed) {
    return { status: "REFUSED", reason: nativeClaim.reason, detail: nativeClaim.detail };
  }
  const mafClaim = await store.claimSlot(pair.maf);
  if (!mafClaim.claimed) {
    // The NATIVE reservation is left to expire. It carries no provider-start intent, which is
    // durable proof no participant was spawned under it, so reclaiming it later cannot double-bill.
    return { status: "REFUSED", reason: mafClaim.reason, detail: mafClaim.detail };
  }

  const nativeState = await store.inspectSlot(pair.native.slotId);
  const mafState = await store.inspectSlot(pair.maf.slotId);

  // 2. Declare intent for BOTH arms IMMEDIATELY after claiming, before any slow work.
  //
  //    Ordering matters for lease safety. The reservation lease only governs the claim -> intent
  //    window; once an intent exists the slot is fail-closed forever. Hashing a fixture tree could
  //    take longer than the lease, so doing it before the intent would open a window in which
  //    another process could reclaim a slot this one is about to spawn under. Declaring intent first
  //    keeps that window to two exclusive file creates.
  const nativeIntent = await store.declareProviderStartIntent({
    slot: pair.native,
    generation: nativeState.generation,
    attemptNumber: 1,
    requestedModel: FROZEN_PARAMETERS.model,
    effort: FROZEN_PARAMETERS.effort,
  });
  const mafIntent = await store.declareProviderStartIntent({
    slot: pair.maf,
    generation: mafState.generation,
    attemptNumber: 1,
    requestedModel: FROZEN_PARAMETERS.model,
    effort: FROZEN_PARAMETERS.effort,
  });

  // 3. Starting state: one pristine fixture, proven identical for both arms.
  //
  //    This now runs AFTER the intents exist, so a failure here would otherwise leave two dangling
  //    intents demanding human adjudication for a run that provably never spawned. The catch below
  //    settles them explicitly as never-started -- which is only sound because nothing between the
  //    intent and `runPair` can spawn a participant. A genuine crash writes no outcome at all and
  //    correctly remains ambiguous.
  let nativeSource: Awaited<ReturnType<typeof captureSourceRevision>>;
  let mafSource: Awaited<ReturnType<typeof captureSourceRevision>>;
  const fixturePath = config.fixtureRootResolver(pair.native.taskId);
  try {
    nativeSource = await captureSourceRevision({ fixturePath });
    mafSource = await captureSourceRevision({ fixturePath });
    assertStartingStateParity(nativeSource, mafSource);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const [slot, intent] of [
      [pair.native, nativeIntent],
      [pair.maf, mafIntent],
    ] as const) {
      await store.recordAttemptOutcome({
        slotId: slot.slotId,
        attemptId: intent.attemptId,
        generation: intent.generation,
        finishedAt: new Date().toISOString(),
        classification: "NEVER_STARTED_PRE_SPAWN_FAILURE",
        costUsd: 0,
        costStatus: "KNOWN",
      });
    }
    return {
      status: "REFUSED",
      reason: "PRE_SPAWN_FAILURE",
      detail:
        `preparation failed before any participant was spawned, so both intents were settled as ` +
        `never-started rather than left ambiguous: ${reason}`,
    };
  }

  // 4. The audited paired execution. Both arms receive identical frozen controlled variables; the
  //    only differences are the treatment ones Protocol v2 declares.
  const controllerConfig = {
    requestedModel: FROZEN_PARAMETERS.model,
    effort: FROZEN_PARAMETERS.effort,
    provider: FROZEN_PARAMETERS.provider,
    timeoutMs: FROZEN_PARAMETERS.timeoutMs,
    budgetUsd: FROZEN_PARAMETERS.perRunCeilingUsd,
    ...(config.claudeCommand ? { claudeCommand: config.claudeCommand } : {}),
    protocolTag: PROTOCOL_V2_TAG,
    protocolSha: PROTOCOL_V2_SHA,
    suiteTag: SUITE_TAG,
    suiteSha: SUITE_SHA,
  };
  const controller = config.controllerFactory
    ? config.controllerFactory(controllerConfig)
    : new ExperimentRunController(controllerConfig);

  const verifier = new CuratorIndependentVerifier({
    evaluationRoot: path.join(config.repoRoot, "evaluation"),
    locate: config.verifierLocate,
  });

  const { provenance } = await controller.runPair({
    scoringStatus: "SCORING",
    taskId: pair.native.taskId,
    prompt: options.prompt,
    expectedVerification: options.expectedVerification,
    pristineRepoPath: fixturePath,
    verifier,
    runNumber: pair.native.replicate,
    randomizationPosition: pair.native.randomizationPosition,
  });

  const nativeBase = provenance.find((record) => record.arm === "NATIVE");
  const mafBase = provenance.find((record) => record.arm === "MAF");
  if (!nativeBase || !mafBase) {
    throw new Error(`runPair did not return provenance for both arms of ${pair.native.taskId}`);
  }

  // 5. Settle both attempts. This is what closes the ambiguity window opened in step 3.
  for (const [slot, intent, base] of [
    [pair.native, nativeIntent, nativeBase],
    [pair.maf, mafIntent, mafBase],
  ] as const) {
    await store.recordAttemptOutcome({
      slotId: slot.slotId,
      attemptId: intent.attemptId,
      generation: intent.generation,
      finishedAt: base.finishedAt,
      classification: base.failureClassification,
      costUsd: base.cost.totalCostUsd,
      costStatus: base.cost.costStatus,
    });
  }

  const nativeProvenance = buildScoringProvenance({
    base: nativeBase,
    slot: pair.native,
    generation: nativeIntent.generation,
    attemptId: nativeIntent.attemptId,
    runnerSha: config.runnerSha,
    sourceRevision: nativeSource,
  });
  const mafProvenance = buildScoringProvenance({
    base: mafBase,
    slot: pair.maf,
    generation: mafIntent.generation,
    attemptId: mafIntent.attemptId,
    runnerSha: config.runnerSha,
    sourceRevision: mafSource,
  });

  // 6. Durable, append-only observations.
  for (const [slot, record] of [
    [pair.native, nativeProvenance],
    [pair.maf, mafProvenance],
  ] as const) {
    await store.appendObservation({
      slotId: slot.slotId,
      slotDigest: slot.slotDigest,
      generation: record.slot.generation,
      taskId: slot.taskId,
      arm: slot.arm as Arm,
      replicate: slot.replicate,
      randomizationPosition: slot.randomizationPosition,
      sequencePosition: slot.sequencePosition,
      analysisTag: ANALYSIS_TAG,
      analysisSha: ANALYSIS_SHA,
      analysisVersion: ANALYSIS_VERSION,
      infrastructureInvalid: record.infrastructureStatus.infrastructureFailure,
      dvs: record.dvs,
      runValidity: record.effectiveRunValidity,
      costUsd: record.cost.totalCostUsd,
      costStatus: record.cost.costStatus,
      provenance: record,
    });
  }

  return {
    status: "EXECUTED",
    nativeProvenance,
    mafProvenance,
    argv: { native: verifySpawnArgv(nativeBase), maf: verifySpawnArgv(mafBase) },
  };
};

/** Groups the frozen schedule into its natural paired execution units, preserving frozen order. */
export const pairSlots = (slots: readonly RunSlot[]): PairedSlotPair[] => {
  const byKey = new Map<string, { native?: RunSlot; maf?: RunSlot; order: number }>();
  slots.forEach((slot) => {
    const key = `${slot.taskId}::r${slot.replicate}`;
    const entry = byKey.get(key) ?? { order: slot.sequencePosition };
    if (slot.arm === "NATIVE") entry.native = slot;
    else entry.maf = slot;
    entry.order = Math.min(entry.order, slot.sequencePosition);
    byKey.set(key, entry);
  });
  return [...byKey.values()]
    .filter((entry): entry is { native: RunSlot; maf: RunSlot; order: number } =>
      Boolean(entry.native && entry.maf),
    )
    .sort((a, b) => a.order - b.order)
    .map(({ native, maf }) => ({ native, maf }));
};
