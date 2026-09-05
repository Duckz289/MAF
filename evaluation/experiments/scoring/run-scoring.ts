#!/usr/bin/env node
// MAF Scoring Runner v2 -- command line entry point.
//
// `execute` contains the COMPLETE billed scoring path: gate -> capability -> paired execution ->
// durable persistence -> per-pair budget re-check. It is written in full here on purpose. The only
// thing preventing it from spending money at this revision is external state: RUNNER_FROZEN
// requires `maf-scoring-runner-v2` to exist locally AND on origin and to peel to this exact HEAD.
// Creating and pushing that tag activates this code exactly as written -- there is no freeze-time
// source change, no flag to flip, and no second runner revision. Every other command makes zero
// provider calls.
//
// RUNNER v2: WHY THE TEST SEAMS LOOK DIFFERENT
// --------------------------------------------
// Runner v1 had ONE seam, `--git-fixture`, whose module supplied simulated git state AND the fake
// executable AND the auth probe AND the participant fixture root together. Convenient, and exactly
// wrong: the seam was optional, so a test that passed nothing got the REAL versions of all four.
// Incident maf-scoring-incident-2026-09-03-v1 is what that costs -- a test drove this command with
// `--confirm-billed-scoring` against the real repository, every gate passed once the v1 tag existed,
// and six frozen-suite runs were billed to the operator's real Claude subscription.
//
// v2 keeps the seams (the production composition must still be testable end to end before the tag
// exists) but changes their failure direction. `--test-fixture` must supply EVERY dependency it
// stands in for, and under a TEST execution context `execute` REFUSES unless it was supplied. There
// is no partial injection and no fall-through to a real dependency: absence is a refusal.
//
// Usage:
//   tsx evaluation/experiments/scoring/run-scoring.ts plan [--json] [--task <id>] [--limit <n>]
//   tsx evaluation/experiments/scoring/run-scoring.ts validate [--skip-remote]
//   tsx evaluation/experiments/scoring/run-scoring.ts init --campaign <dir> [--ceiling-usd <n>]
//   tsx evaluation/experiments/scoring/run-scoring.ts status --campaign <dir>
//   tsx evaluation/experiments/scoring/run-scoring.ts next --campaign <dir> [--limit <n>]
//   tsx evaluation/experiments/scoring/run-scoring.ts execute --campaign <dir> [--confirm-billed-scoring]
//   tsx evaluation/experiments/scoring/run-scoring.ts request-rerun --campaign <dir> --slot <id> --operator <name> --reason <text>
//   tsx evaluation/experiments/scoring/run-scoring.ts adjudicate --campaign <dir> --slot <id> --attempt <id> --operator <name> --billed <determination> --allow-retry <bool> --reason <text>
//   tsx evaluation/experiments/scoring/run-scoring.ts aggregate --campaign <dir> [--json]

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ANALYSIS_SHA,
  ANALYSIS_TAG,
  ANALYSIS_VERSION,
  FROZEN_PARAMETERS,
  INCIDENT_SHA,
  INCIDENT_TAG,
  KNOWN_SOURCE_METADATA_NOTE,
  PROTOCOL_V2_SHA,
  PROTOCOL_V2_TAG,
  RUNNER_TAG,
  RUNNER_V1_STATUS,
  RUNNER_V1_TAG,
  RUNNER_VERSION,
  SUITE_SHA,
  SUITE_TAG,
} from "./lib/frozen-refs";
import {
  buildScoringSchedule,
  loadFrozenRandomization,
  loadFrozenTaskIds,
  selectBatch,
  summarizeSchedule,
  type ScoringSchedule,
} from "./lib/schedule";
import { ScoringStateStore, type SlotState } from "./lib/state-store";
import { evaluateCampaignGate, theoreticalMaximumCampaignUsd } from "./lib/campaign-budget";
import { evaluateExecutionGate, type ManifestParameters } from "./lib/execution-gate";
import { verifyFrozenArtifacts, resolveRunnerTagSha } from "./lib/tag-verification";
import { runFrozenAnalysis } from "./lib/analysis-binding";
import { pinClaudeExecutable } from "./lib/executable-gate";
import { issueProviderAuthorization } from "./lib/execution-gate";
import { executePairedSlots, pairSlots } from "./lib/participant-runner";
import { inspectEffectiveClaudeConfig } from "./lib/effective-config-gate";
import {
  approveTestDoubleProvider,
  detectExecutionContext,
  observeTestDoubleMarker,
  resolveRealProviderIdentity,
  type ExecutionContext,
  type ProviderIdentity,
} from "./lib/provider-identity";
import { checkEnvironmentRouting } from "../real/lib/preflight-gate";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";

const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

/** Pins an exact binary for the version/auth probe and for any future participant execution. */
const claudePathOverride = value("claude-path");

/** How this process is classified. Re-derived at the spawn boundary; never cached into a capability. */
const executionContext: ExecutionContext = detectExecutionContext();

/**
 * The complete, explicit test-seam surface (mission Repair 5).
 *
 * Each field stands in for exactly one real dependency, and `--test-fixture` must supply ALL of
 * them. A module that provides three of four is refused rather than silently completed with the
 * real fourth -- "no automatic fallback to real dependencies when a required test seam is absent"
 * is the whole point, since the missing one in Runner v1 was the provider executable.
 */
interface TestSeams {
  /** Git/tag resolution. */
  git: (args: string[], cwd: string) => Promise<string>;
  /** The approved fake executable. Must pass `approveTestDoubleProvider` before it is used. */
  testDoubleProviderPath: string;
  /** Executable resolution probe (stands in for `claude --version`). */
  resolve: unknown;
  /** Authentication probe (stands in for `claude auth status`). */
  checkAuth: unknown;
  /** Filesystem root the simulated participants start from. */
  participantFixtureRoot: string;
}

const testFixtureModule = value("test-fixture");
let testSeams: TestSeams | null = null;

/** A refusal that must be printed and obeyed before anything resolves, probes or spawns. */
interface SeamRefusal {
  code: string;
  detail: string;
}
let seamRefusal: SeamRefusal | null = null;

/**
 * Loads the test-seam module, if one was named, and validates that it is COMPLETE.
 *
 * Deliberately does no work at all when `--test-fixture` is absent: the decision about what that
 * absence means belongs to `requireProviderIsolation`, which knows the execution context.
 */
const loadTestSeams = async (): Promise<void> => {
  if (!testFixtureModule || testSeams || seamRefusal) return;
  // A Windows absolute path is not a valid ESM specifier; it must be a file:// URL.
  const fixtureUrl = testFixtureModule.startsWith("file:")
    ? testFixtureModule
    : pathToFileURL(path.resolve(testFixtureModule)).href;
  let loaded: Partial<TestSeams>;
  try {
    loaded = (await import(fixtureUrl)) as Partial<TestSeams>;
  } catch (error) {
    seamRefusal = {
      code: "TEST_SEAM_UNLOADABLE",
      detail: `--test-fixture ${testFixtureModule} could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
    return;
  }
  const required = [
    "git",
    "testDoubleProviderPath",
    "resolve",
    "checkAuth",
    "participantFixtureRoot",
  ] as const;
  const missing = required.filter((key) => loaded[key] === undefined || loaded[key] === null);
  if (missing.length > 0) {
    seamRefusal = {
      code: "TEST_SEAM_INCOMPLETE",
      detail:
        `--test-fixture ${testFixtureModule} does not supply ${missing.join(", ")}. A test fixture ` +
        "must stand in for EVERY real dependency it replaces; a partial fixture would leave the " +
        "rest resolving to real ones, which is how incident " +
        `${INCIDENT_TAG} reached the operator's real Claude executable.`,
    };
    return;
  }
  testSeams = loaded as TestSeams;
};

/**
 * The structural interlock, evaluated BEFORE any resolution, probe or spawn (mission Repairs 1-3).
 *
 * Two rules, each the direct negation of one half of the incident:
 *
 *   TEST context       -> a complete `--test-fixture` is MANDATORY. Runner v1's real-repository test
 *                         supplied nothing and got the real provider; here it gets a refusal, and it
 *                         gets one before `pinClaudeExecutable` can so much as run `--version`
 *                         against the operator's binary.
 *   PRODUCTION context -> test seams are FORBIDDEN. Simulated freeze state and a fake executable
 *                         must never produce observations an operator could mistake for paid ones.
 *
 * Neither rule consults a tag, a remote, or any other external state, so no future freeze ceremony
 * can invalidate the assumption either one rests on.
 */
const requireProviderIsolation = (): SeamRefusal | null => {
  if (seamRefusal) return seamRefusal;
  if (executionContext.kind === "TEST" && testSeams === null) {
    return {
      code: "TEST_CONTEXT_WITHOUT_TEST_PROVIDER",
      detail:
        `execute was invoked in a TEST execution context (${executionContext.signals.join(", ")}) ` +
        "without --test-fixture. A test may not reach the participant executable at all -- not the " +
        "pinned real Claude binary, not a PATH lookup, not a bare `claude`. Supply a complete " +
        "--test-fixture naming an approved TEST_DOUBLE provider, or run this command outside a " +
        `test harness. See incident ${INCIDENT_TAG} (${INCIDENT_SHA}).`,
    };
  }
  if (executionContext.kind === "PRODUCTION" && testSeams !== null) {
    return {
      code: "TEST_SEAM_IN_PRODUCTION_CONTEXT",
      detail:
        "--test-fixture was supplied outside a test harness. Simulated git state and a fake " +
        "executable must never produce observations in a production execution context.",
    };
  }
  return null;
};

/**
 * Establishes WHICH provider this invocation may spawn (mission Repairs 1, 2 and 6).
 *
 * Exactly two outcomes are reachable, and "resolve whatever `claude` is on this machine" is not one
 * of them. Under test the approval is a positive proof about the file's bytes; in production the
 * identity is refused if the pinned binary turns out to be a test double.
 */
const establishProviderIdentity = async (
  pinnedPath: string | null,
): Promise<{ identity: ProviderIdentity | null; detail: string }> => {
  if (executionContext.kind === "TEST") {
    const outcome = await approveTestDoubleProvider({
      ...(testSeams ? { executablePath: testSeams.testDoubleProviderPath } : {}),
      context: executionContext,
    } as Parameters<typeof approveTestDoubleProvider>[0]);
    return outcome.approved
      ? { identity: outcome.identity, detail: outcome.identity.detail }
      : { identity: null, detail: `${outcome.reason}: ${outcome.detail}` };
  }
  const markerObserved = pinnedPath === null ? false : await observeTestDoubleMarker(pinnedPath);
  const outcome = resolveRealProviderIdentity({
    executablePath: pinnedPath,
    context: executionContext,
    markerObserved,
  });
  return outcome.approved
    ? { identity: outcome.identity, detail: outcome.identity.detail }
    : { identity: null, detail: `${outcome.reason}: ${outcome.detail}` };
};

const requireCampaign = (): string => {
  const dir = value("campaign");
  if (!dir) {
    process.stderr.write("--campaign <dir> is required for this command\n");
    process.exit(2);
  }
  return path.resolve(dir);
};

const loadManifest = async (): Promise<ManifestParameters> => {
  const raw = JSON.parse(
    await readFile(
      path.join(repoRoot, "evaluation", "experiments", "native-vs-maf-v2.json"),
      "utf8",
    ),
  ) as {
    modelConfiguration: { model: string; provider: string; effort: string };
    timeoutMs: number;
    budget: { perRunCeilingUsd: number };
    runsPerTask: number;
    totalScoringRunsPlanned: number;
    frozenSuite: { tag: string; sha: string };
  };
  return {
    model: raw.modelConfiguration.model,
    provider: raw.modelConfiguration.provider,
    effort: raw.modelConfiguration.effort,
    timeoutMs: raw.timeoutMs,
    perRunCeilingUsd: raw.budget.perRunCeilingUsd,
    runsPerTask: raw.runsPerTask,
    totalScoringRunsPlanned: raw.totalScoringRunsPlanned,
    suiteTag: raw.frozenSuite.tag,
    suiteSha: raw.frozenSuite.sha,
  };
};

const buildSchedule = async (): Promise<ScoringSchedule> => {
  const [randomization, frozenTaskIds, manifest] = await Promise.all([
    loadFrozenRandomization(repoRoot),
    loadFrozenTaskIds(repoRoot),
    loadManifest(),
  ]);
  return buildScoringSchedule({
    randomization,
    frozenTaskIds,
    runsPerTask: manifest.runsPerTask,
  });
};

const header = (title: string): void => {
  out(`MAF Scoring Runner v${RUNNER_VERSION} -- ${title}`);
  out("=".repeat(60));
  out();
};

// ------------------------------------------------------------------- plan

const commandPlan = async (): Promise<void> => {
  const schedule = await buildSchedule();
  const summary = summarizeSchedule(schedule);
  const taskFilter = value("task");
  const limitRaw = value("limit");
  const slots = selectBatch(schedule, {
    ...(taskFilter ? { taskIds: [taskFilter] } : {}),
    ...(limitRaw ? { limit: Number.parseInt(limitRaw, 10) } : {}),
  });

  if (flag("json")) {
    out(JSON.stringify({ schedule: { ...schedule, slots }, summary }, null, 2));
    return;
  }

  header("frozen 174-run schedule (PLAN ONLY, no provider calls)");
  out(`suite:            ${SUITE_TAG} ${SUITE_SHA}`);
  out(`protocol:         ${PROTOCOL_V2_TAG} ${PROTOCOL_V2_SHA}`);
  out(`randomization:    ${schedule.randomizationSeed}`);
  out(`schedule digest:  ${schedule.scheduleDigest}`);
  out(`replicate nesting:${schedule.replicateNesting}`);
  out();
  out(`TASK_COUNT:   ${summary.taskCount}`);
  out(`NATIVE_RUNS:  ${summary.nativeRuns}`);
  out(`MAF_RUNS:     ${summary.mafRuns}`);
  out(`TOTAL_RUNS:   ${summary.totalRuns}`);
  out(
    `first-arm:    ${summary.nativeFirstTasks} NATIVE_FIRST / ${summary.mafFirstTasks} MAF_FIRST`,
  );
  out(`duplicates:   ${summary.duplicateSlotIds.length}`);
  out(
    `theoretical max spend: $${theoreticalMaximumCampaignUsd(summary.totalRuns, FROZEN_PARAMETERS.perRunCeilingUsd)}`,
  );
  out();
  out(`showing ${slots.length} slot(s):`);
  for (const slot of slots) {
    out(
      `  #${String(slot.sequencePosition).padStart(3, "0")} ${slot.slotId.padEnd(52)} ` +
        `pos=${String(slot.randomizationPosition).padStart(2, "0")} ${slot.armOrder}`,
    );
  }
};

// --------------------------------------------------------------- validate

const commandValidate = async (): Promise<void> => {
  header("post-freeze scoring readiness validation");
  const skipRemote = flag("skip-remote");
  const frozen = await verifyFrozenArtifacts({ repoRoot, skipRemote });
  for (const check of frozen.checks) {
    out(`  [${check.status === "OK" ? "PASS" : "FAIL"}] ${check.tag}: ${check.detail}`);
  }
  out();

  const schedule = await buildSchedule();
  const summary = summarizeSchedule(schedule);
  const scheduleOk =
    summary.taskCount === FROZEN_PARAMETERS.taskCount &&
    summary.nativeRuns === FROZEN_PARAMETERS.totalScoringRuns / 2 &&
    summary.mafRuns === FROZEN_PARAMETERS.totalScoringRuns / 2 &&
    summary.totalRuns === FROZEN_PARAMETERS.totalScoringRuns &&
    summary.duplicateSlotIds.length === 0 &&
    summary.tasksWithWrongReplicateCount.length === 0;
  out(
    `  [${scheduleOk ? "PASS" : "FAIL"}] schedule: ${summary.taskCount} tasks, ` +
      `${summary.nativeRuns} NATIVE + ${summary.mafRuns} MAF = ${summary.totalRuns} runs`,
  );

  const manifest = await loadManifest();
  const { checkManifestParameters } = await import("./lib/execution-gate");
  const manifestCheck = checkManifestParameters(manifest);
  out(`  [${manifestCheck.passed ? "PASS" : "FAIL"}] manifest: ${manifestCheck.detail}`);

  const effectiveConfig = await inspectEffectiveClaudeConfig({
    forwardedEnvironmentKeys: [],
    workspacePaths: [repoRoot],
  });
  for (const check of effectiveConfig.checks) {
    out(`  [${check.passed ? "PASS" : "FAIL"}] ${check.id}: ${check.detail}`);
  }
  out(
    `         inspected ${effectiveConfig.inspectedFiles.length} active config file(s); ` +
      `${effectiveConfig.excludedPaths.length} historical path(s) excluded by design`,
  );

  const runnerSha = await resolveRunnerTagSha(RUNNER_TAG, { repoRoot });
  out(
    `  [INFO] runner freeze: ${
      runnerSha === null
        ? `${RUNNER_TAG} does not exist yet -- billed scoring is structurally impossible`
        : `${RUNNER_TAG} = ${runnerSha}`
    }`,
  );
  out(`  [INFO] runner v1: ${RUNNER_V1_TAG} is ${RUNNER_V1_STATUS} and can never be selected`);
  out(`  [INFO] execution context: ${executionContext.detail}`);
  out(
    `  [INFO] incident of record: ${INCIDENT_TAG} (${INCIDENT_SHA}); its observations are ` +
      "NON_OFFICIAL and enter no campaign, denominator or report",
  );
  out();
  out(`protocolFreezeAuthority: GIT_TAG`);
  out(`protocolFrozen:          true`);
  out(`known note: ${KNOWN_SOURCE_METADATA_NOTE}`);
  out();
  const planValid = frozen.ok && scheduleOk && manifestCheck.passed && effectiveConfig.clean;
  out(planValid ? "SCORING_PLAN_VALID" : "SCORING_PLAN_INVALID");
  if (!planValid) process.exitCode = 1;
};

// ------------------------------------------------------------------- init

const commandInit = async (): Promise<void> => {
  const root = requireCampaign();
  const schedule = await buildSchedule();
  const ceilingRaw = value("ceiling-usd");
  await loadTestSeams();
  const isolation = requireProviderIsolation();
  if (isolation) {
    header("campaign init REFUSED");
    out(`${isolation.code}: ${isolation.detail}`);
    process.exitCode = 1;
    return;
  }
  const store = new ScoringStateStore({ root });
  const runnerSha = await resolveRunnerTagSha(RUNNER_TAG, {
    repoRoot,
    ...(testSeams ? { git: testSeams.git } : {}),
  });
  // A campaign can only ever hold paid observations if a frozen runner identity exists to bind
  // them to. One created before the freeze stays NON_BILLED_DEVELOPMENT for life.
  const billingMode = runnerSha === null ? "NON_BILLED_DEVELOPMENT" : "PAID";

  const result = await store.createCampaign({
    campaignId: randomUUID(),
    createdAt: new Date().toISOString(),
    suiteTag: SUITE_TAG,
    suiteSha: SUITE_SHA,
    protocolTag: PROTOCOL_V2_TAG,
    protocolSha: PROTOCOL_V2_SHA,
    analysisTag: ANALYSIS_TAG,
    analysisSha: ANALYSIS_SHA,
    analysisVersion: ANALYSIS_VERSION,
    runnerVersion: RUNNER_VERSION,
    runnerTag: RUNNER_TAG,
    runnerSha,
    billingMode,
    scheduleDigest: schedule.scheduleDigest,
    totalSlots: schedule.slots.length,
    campaignCeilingUsd: ceilingRaw === undefined ? null : Number.parseFloat(ceilingRaw),
    protocolFreezeAuthority: "GIT_TAG",
    protocolFrozen: true,
    knownSourceMetadataNote: KNOWN_SOURCE_METADATA_NOTE,
  });

  if (!result.created) {
    header("campaign init REFUSED");
    out(result.detail);
    out();
    out("Recorded observations are paid evidence; init never replaces them. To continue this");
    out("campaign use:  scoring resume --campaign <dir>");
    process.exitCode = 1;
    return;
  }
  await store.createSchedule(schedule);

  header("campaign initialized");
  out(`root:            ${root}`);
  out(`schedule digest: ${schedule.scheduleDigest}`);
  out(`slots:           ${schedule.slots.length}`);
  out(`billing mode:    ${billingMode}`);
  out(
    `ceiling:         ${ceilingRaw === undefined ? "NOT SET (billed scoring refused)" : `$${ceilingRaw}`}`,
  );
  if (billingMode === "NON_BILLED_DEVELOPMENT") {
    out();
    out(
      `No frozen ${RUNNER_TAG} exists, so this campaign is development-only and can never hold ` +
        "paid observations. Initialise a fresh campaign after the runner freeze for real scoring.",
    );
  }
};

// ----------------------------------------------------------------- resume

const commandResume = async (): Promise<void> => {
  const root = requireCampaign();
  const schedule = await buildSchedule();
  const store = new ScoringStateStore({ root });

  const opened = await store.openCampaign({
    suiteSha: SUITE_SHA,
    protocolSha: PROTOCOL_V2_SHA,
    analysisSha: ANALYSIS_SHA,
    scheduleDigest: schedule.scheduleDigest,
  });

  header("resume existing campaign");
  if (!opened.opened) {
    out(`REFUSED: ${opened.detail}`);
    process.exitCode = 1;
    return;
  }
  const states = await store.inspectAll(schedule);
  const complete = states.filter((s) => s.status === "COMPLETE").length;
  out(`campaign:        ${opened.campaign.campaignId}`);
  out(`created:         ${opened.campaign.createdAt}`);
  out(`schedule digest: ${opened.campaign.scheduleDigest} (matches frozen inputs)`);
  out(`progress:        ${complete} / ${schedule.slots.length} slots complete`);
  out(
    `ceiling:         ${
      opened.campaign.campaignCeilingUsd === null
        ? "NOT SET (billed scoring refused)"
        : `$${opened.campaign.campaignCeilingUsd}`
    }`,
  );
};

// ----------------------------------------------------------------- status

const statusCounts = (states: readonly SlotState[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const state of states) counts[state.status] = (counts[state.status] ?? 0) + 1;
  return counts;
};

const commandStatus = async (): Promise<void> => {
  const root = requireCampaign();
  const store = new ScoringStateStore({ root });
  const scheduleOutcome = await store.readSchedule();
  if (scheduleOutcome.status !== "OK") {
    process.stderr.write(
      `campaign schedule unreadable (${scheduleOutcome.status}); run init first\n`,
    );
    process.exit(1);
  }
  const schedule = scheduleOutcome.record.payload;
  const campaign = await store.readCampaign();
  const states = await store.inspectAll(schedule);
  const counts = statusCounts(states);
  const gate = evaluateCampaignGate({
    states,
    ceilingUsd: campaign.status === "OK" ? campaign.record.payload.campaignCeilingUsd : null,
    perRunCeilingUsd: FROZEN_PARAMETERS.perRunCeilingUsd,
  });

  header("campaign status (OPERATIONAL PROGRESS ONLY)");
  out("This view is deliberately technical. It reports completion and spend, never a DVS trend:");
  out("EXPERIMENT_PROTOCOL.md section 18 forbids stopping early on results.");
  out();
  for (const [status, count] of Object.entries(counts).sort()) {
    out(`  ${status.padEnd(20)} ${count}`);
  }
  out();
  out(`  total slots:        ${schedule.slots.length}`);
  out(`  known spend:        $${gate.spend.knownSpendUsd.toFixed(4)} (${gate.spend.spendStatus})`);
  out(`  unknown-cost obs:   ${gate.spend.unknownCostObservations}`);
  out(`  campaign gate:      ${gate.status} -- ${gate.detail}`);

  const recovery = states.filter((s) => s.status === "RECOVERY_REQUIRED");
  if (recovery.length > 0) {
    out();
    out(`  ${recovery.length} SLOT(S) REQUIRE HUMAN ADJUDICATION:`);
    for (const state of recovery) {
      for (const intent of state.danglingIntents) {
        out(`    ${state.slotId} attempt=${intent.attemptId} declared=${intent.declaredAt}`);
      }
    }
  }
};

// ------------------------------------------------------------------- next

const commandNext = async (): Promise<void> => {
  const root = requireCampaign();
  const store = new ScoringStateStore({ root });
  const scheduleOutcome = await store.readSchedule();
  if (scheduleOutcome.status !== "OK") {
    process.stderr.write("campaign schedule unreadable; run init first\n");
    process.exit(1);
  }
  const schedule = scheduleOutcome.record.payload;
  const limit = Number.parseInt(value("limit") ?? "6", 10);
  const states = await store.inspectAll(schedule);
  const byId = new Map(states.map((state) => [state.slotId, state]));

  header("next pending run slots (frozen order preserved)");
  let shown = 0;
  for (const slot of schedule.slots) {
    if (shown >= limit) break;
    const state = byId.get(slot.slotId);
    if (!state || state.status === "COMPLETE") continue;
    out(
      `  #${String(slot.sequencePosition).padStart(3, "0")} ${slot.slotId.padEnd(52)} ${state.status}`,
    );
    shown += 1;
  }
  if (shown === 0) out("  no pending slots: every scheduled observation is recorded");
};

// ---------------------------------------------------------------- execute

/**
 * Resolves the prompt, pristine fixture and hidden-grader locator for one frozen suite task.
 *
 * Phase B and Phase C tasks live under different roots, so the phase is derived from the frozen
 * contracts rather than guessed from the id.
 */
const loadScoringTask = async (
  taskId: string,
): Promise<{
  prompt: string;
  expectedVerification: string;
  fixtureRootResolver: (id: string) => string;
  verifierLocate: (id: string) => { phase: string; taskId: string } | null;
}> => {
  const contracts = JSON.parse(
    await readFile(path.join(repoRoot, "evaluation", "contracts", "tasks.json"), "utf8"),
  ) as Array<{ id: string; phase?: string; band?: string }>;
  const entry = contracts.find((task) => task.id === taskId);
  if (!entry) throw new Error(`task ${taskId} is not a member of the frozen suite`);
  const phase =
    entry.phase ?? (taskId.startsWith("b1-") || taskId.startsWith("b2-") ? "phase-c" : "phase-b");

  const fixtureRoot =
    testSeams?.participantFixtureRoot ??
    path.join(repoRoot, "evaluation", "fixtures", phase, taskId, "public", "repo");
  const promptPath = path.join(
    repoRoot,
    "evaluation",
    "fixtures",
    phase,
    taskId,
    "public",
    "prompt.md",
  );
  const prompt = await readFile(promptPath, "utf8").catch(
    () => `Complete the task described in the repository at ${taskId}.`,
  );
  return {
    prompt,
    expectedVerification: `the frozen hidden grader for ${taskId} passes`,
    fixtureRootResolver: () => fixtureRoot,
    verifierLocate: (id: string) => ({ phase, taskId: id }),
  };
};

const commandExecute = async (): Promise<void> => {
  // STRUCTURAL PROVIDER ISOLATION RUNS FIRST -- before the campaign is opened, before git is
  // consulted, and above all before `pinClaudeExecutable` can resolve or probe anything. In the
  // incident, resolution happened early and unconditionally, so by the time any gate had an opinion
  // the real executable had already been located. Here a TEST context without a complete
  // `--test-fixture` stops the command dead, with zero processes spawned of any kind.
  await loadTestSeams();
  const isolation = requireProviderIsolation();
  if (isolation) {
    header("billed scoring execution gate");
    out(`  [FAIL] ${isolation.code}: ${isolation.detail}`);
    out();
    out("SCORING_EXECUTION_REFUSED");
    out();
    out(
      "No executable was resolved, no probe was run, no participant executor was constructed and " +
        "no provider was contacted. Structural provider isolation refused before any of that could " +
        "happen.",
    );
    process.exitCode = 1;
    return;
  }

  const pinnedRunnerSha = await resolveRunnerTagSha(RUNNER_TAG, {
    repoRoot,
    ...(testSeams ? { git: testSeams.git } : {}),
  });
  const root = requireCampaign();
  const store = new ScoringStateStore({ root });
  const scheduleOutcome = await store.readSchedule();
  if (scheduleOutcome.status !== "OK") {
    process.stderr.write("campaign schedule unreadable; run init first\n");
    process.exit(1);
  }
  const schedule = scheduleOutcome.record.payload;
  const campaign = await store.readCampaign();
  const states = await store.inspectAll(schedule);
  const manifest = await loadManifest();
  const ceilingFlag = value("ceiling-usd");
  const ceiling =
    ceilingFlag !== undefined
      ? Number.parseFloat(ceilingFlag)
      : campaign.status === "OK"
        ? campaign.record.payload.campaignCeilingUsd
        : null;

  const campaignGate = evaluateCampaignGate({
    states,
    ceilingUsd: ceiling,
    perRunCeilingUsd: FROZEN_PARAMETERS.perRunCeilingUsd,
  });

  // The effective-configuration inspection reads files only; it spawns nothing and contacts no
  // provider, so it runs unconditionally and its result is reported even when the gate refuses for
  // other reasons.
  const effectiveConfig = await inspectEffectiveClaudeConfig({
    // The adapter's spawn env allowlist contains no ANTHROPIC_* key
    // (src/infrastructure/claude-code-adapter.ts), asserted by tests/claude-code-adapter-env.test.ts.
    forwardedEnvironmentKeys: [],
    // Participant workspaces are materialised from repository fixtures, so a `.claude` directory
    // committed into the repo would be copied into the participant's cwd and take effect there.
    workspacePaths: [repoRoot],
  });

  // Resolve ONE executable and probe it. `--version` and `auth status` are local, free, and invoke
  // no model; running them here is what lets first-party authentication be proven before any money
  // is committed, and it guarantees the binary that was checked is the binary that would run.
  //
  // Under test every one of these arguments comes from the fixture, so the probe never touches the
  // operator's binary; in production none of them exists and the real primitives run unchanged.
  const pinned = await pinClaudeExecutable({
    ...(claudePathOverride ? { preferredPath: claudePathOverride } : {}),
    ...(testSeams ? { preferredPath: testSeams.testDoubleProviderPath } : {}),
    ...(testSeams ? { resolve: testSeams.resolve as never } : {}),
    ...(testSeams ? { checkAuth: testSeams.checkAuth as never } : {}),
  });

  // WHICH provider may be spawned. Null is a refusal the gate reports; it is never a licence to
  // fall back to a resolved `claude`.
  const provider = await establishProviderIdentity(pinned.path);

  const decision = await evaluateExecutionGate({
    repoRoot,
    billedConfirmed: flag("confirm-billed-scoring"),
    manifest,
    slotStates: states,
    campaignGate,
    pinnedExecutable: pinned,
    routing: checkEnvironmentRouting(),
    effectiveConfig,
    providerIdentity: provider.identity,
    providerIdentityDetail: provider.detail,
    gitStateInjected: testSeams !== null,
    executionContext,
    ...(testSeams ? { git: testSeams.git } : {}),
  });

  header("billed scoring execution gate");
  for (const check of decision.checks) {
    out(`  [${check.passed ? "PASS" : "FAIL"}] ${check.id}: ${check.detail}`);
  }
  out();
  out(decision.summary);
  out();

  if (!decision.authorized) {
    out("SCORING_EXECUTION_REFUSED");
    out();
    out(
      "No participant executor was constructed and no provider was contacted. Execution stops " +
        "here because a gate above failed; nothing further in this command can spawn a participant.",
    );
    process.exitCode = 1;
    return;
  }

  // ---------------------------------------------------------------- execute
  //
  // Everything past this point is the real, complete billed path. It is reached only when EVERY
  // gate passed -- which today is impossible, because RUNNER_FROZEN requires maf-scoring-runner-v1
  // to exist locally and on origin and to peel to this exact HEAD. That is the ONLY thing standing
  // between this revision and real execution: creating and pushing the tag activates this code as
  // written, with no source change of any kind.

  const campaignMetadata = campaign.status === "OK" ? campaign.record.payload : null;
  if (!campaignMetadata) {
    out("SCORING_EXECUTION_REFUSED: campaign metadata is unreadable");
    process.exitCode = 1;
    return;
  }

  // A campaign created before the runner freeze has no frozen runner identity to bind paid
  // observations to, and is never silently promoted.
  const opened = await store.openCampaign({
    suiteSha: SUITE_SHA,
    protocolSha: PROTOCOL_V2_SHA,
    analysisSha: ANALYSIS_SHA,
    scheduleDigest: schedule.scheduleDigest,
    runnerTag: RUNNER_TAG,
    runnerSha: pinnedRunnerSha,
    requirePaid: true,
  });
  if (!opened.opened) {
    out(`SCORING_EXECUTION_REFUSED: ${opened.detail}`);
    process.exitCode = 1;
    return;
  }

  // The gate authorized, so an identity exists; the spawn boundary re-checks it anyway.
  const providerIdentity = provider.identity as ProviderIdentity;
  const executablePath = providerIdentity.executablePath;
  const frozenTaskIds = await loadFrozenTaskIds(repoRoot);
  const batchTaskLimit = Number.parseInt(value("tasks") ?? "1", 10);

  // Batch selection follows the frozen schedule order; it never reorders or reduces N.
  const pendingTasks: string[] = [];
  const stateById = new Map(states.map((state) => [state.slotId, state]));
  for (const slot of schedule.slots) {
    const state = stateById.get(slot.slotId);
    if (state && state.status !== "COMPLETE" && !pendingTasks.includes(slot.taskId)) {
      pendingTasks.push(slot.taskId);
    }
  }
  const batchTasks = pendingTasks.slice(0, Math.max(1, batchTaskLimit));
  const pairs = pairSlots(selectBatch(schedule, { taskIds: batchTasks }));

  out("SCORING_EXECUTION_AUTHORIZED");
  out();
  out(`provider identity: ${providerIdentity.kind}`);
  out(`executable:        ${executablePath}`);
  out(`executing ${pairs.length} pair(s) across task(s): ${batchTasks.join(", ")}`);
  out();

  let executed = 0;
  let refused = 0;
  for (const pair of pairs) {
    // Re-evaluate the campaign budget BEFORE every pair, against a fresh full $16 exposure and the
    // actual persisted spend so far. A pair that cost less than its ceiling leaves the difference
    // available; a campaign that can no longer cover one full pair stops here rather than mid-pair.
    const currentStates = await store.inspectAll(schedule);
    const perPairGate = evaluateCampaignGate({
      states: currentStates,
      ceilingUsd: ceiling,
      perRunCeilingUsd: FROZEN_PARAMETERS.perRunCeilingUsd,
    });
    if (!perPairGate.authorized) {
      out(`  STOP before ${pair.native.taskId} r${pair.native.replicate}: ${perPairGate.detail}`);
      break;
    }

    // Mint a capability bound to THIS campaign, schedule, pair and absolute executable. The
    // provider boundary re-checks every one of those bindings before it spawns anything.
    const authorization = issueProviderAuthorization({
      decision,
      campaignId: campaignMetadata.campaignId,
      scheduleDigest: schedule.scheduleDigest,
      nativeSlotDigest: pair.native.slotDigest,
      mafSlotDigest: pair.maf.slotDigest,
      providerIdentity,
    });
    if (!authorization) {
      out(
        `  REFUSED ${pair.native.taskId} r${pair.native.replicate}: capability could not be issued`,
      );
      refused += 1;
      continue;
    }

    const task = await loadScoringTask(pair.native.taskId);
    const result = await executePairedSlots(
      {
        repoRoot,
        store,
        frozenTaskIds,
        claudeCommand: executablePath,
        runnerSha: pinnedRunnerSha,
        campaignId: campaignMetadata.campaignId,
        scheduleDigest: schedule.scheduleDigest,
        fixtureRootResolver: task.fixtureRootResolver,
        verifierLocate: task.verifierLocate,
      },
      pair,
      {
        prompt: task.prompt,
        expectedVerification: task.expectedVerification,
        authorization,
      },
    );

    if (result.status === "EXECUTED") {
      executed += 1;
      out(
        `  EXECUTED ${pair.native.taskId} r${pair.native.replicate}: ` +
          `native dvs=${result.nativeProvenance.dvs} maf dvs=${result.mafProvenance.dvs} ` +
          `argv native=${result.argv.native.ok ? "ok" : "BAD"} maf=${result.argv.maf.ok ? "ok" : "BAD"}`,
      );
    } else {
      refused += 1;
      out(
        `  REFUSED ${pair.native.taskId} r${pair.native.replicate}: ${result.reason} -- ${result.detail}`,
      );
    }
  }

  out();
  out(`pairs executed: ${executed}   pairs refused/stopped: ${refused}`);
  out("Observations, costs and provenance are persisted; run `aggregate` for the frozen analysis.");
};

// ------------------------------------------------------------- batch plan

const commandBatchPlan = async (): Promise<void> => {
  const root = requireCampaign();
  const store = new ScoringStateStore({ root });
  const scheduleOutcome = await store.readSchedule();
  if (scheduleOutcome.status !== "OK") {
    process.stderr.write("campaign schedule unreadable; run init first\n");
    process.exit(1);
  }
  const schedule = scheduleOutcome.record.payload;
  const states = await store.inspectAll(schedule);
  const byId = new Map(states.map((state) => [state.slotId, state]));

  // The natural operational unit: one task = 3 NATIVE + 3 MAF, in frozen order. Batching pauses
  // execution at a boundary; it never reorders, reduces N, or ends the campaign early.
  const pendingTasks: string[] = [];
  for (const slot of schedule.slots) {
    const state = byId.get(slot.slotId);
    if (state && state.status !== "COMPLETE" && !pendingTasks.includes(slot.taskId)) {
      pendingTasks.push(slot.taskId);
    }
  }
  const batchTasks = pendingTasks.slice(0, Number.parseInt(value("tasks") ?? "1", 10));
  const slots = selectBatch(schedule, { taskIds: batchTasks });

  header("dry batch plan (NO provider calls)");
  out(`tasks in batch: ${batchTasks.join(", ") || "(none pending)"}`);
  out(`slots in batch: ${slots.length}`);
  out(
    `worst-case spend: $${slots.length * FROZEN_PARAMETERS.perRunCeilingUsd} ` +
      `(${slots.length} x $${FROZEN_PARAMETERS.perRunCeilingUsd} frozen per-run ceiling)`,
  );
  out();
  for (const slot of slots) {
    const state = byId.get(slot.slotId);
    out(
      `  #${String(slot.sequencePosition).padStart(3, "0")} ${slot.slotId.padEnd(52)} ${state?.status ?? "PLANNED"}`,
    );
  }
  out();
  out(
    "Completing this batch PAUSES operational execution at a frozen schedule boundary. It is not " +
      "an early stop: the campaign's commitment remains all 174 runs, and the remaining slots stay " +
      "pending in unchanged order.",
  );
};

// --------------------------------------------------------- operator actions

const commandRequestRerun = async (): Promise<void> => {
  const root = requireCampaign();
  const slotId = value("slot");
  const operator = value("operator");
  const reason = value("reason");
  if (!slotId || !operator || !reason) {
    process.stderr.write("--slot, --operator and --reason are all required\n");
    process.exit(2);
  }
  const store = new ScoringStateStore({ root });
  const result = await store.authorizeInfrastructureRerun({ slotId, operator, reason });
  header("infrastructure rerun authorization");
  if (result.authorized) {
    out(`AUTHORIZED: slot ${slotId} may be rerun once.`);
    out(`  supersedes observation: ${result.record.supersedesObservationIndex}`);
    out("  the original observation is preserved and is never deleted or overwritten");
  } else {
    out(`REFUSED: ${result.detail}`);
    process.exitCode = 1;
  }
};

const commandAdjudicate = async (): Promise<void> => {
  const root = requireCampaign();
  const slotId = value("slot");
  const attemptId = value("attempt");
  const operator = value("operator");
  const reason = value("reason");
  const billed = value("billed");
  const allowRetry = value("allow-retry");
  if (!slotId || !attemptId || !operator || !reason || !billed || !allowRetry) {
    process.stderr.write(
      "--slot, --attempt, --operator, --billed, --allow-retry and --reason are all required\n",
    );
    process.exit(2);
  }
  const valid = ["CONFIRMED_BILLED", "CONFIRMED_NOT_BILLED", "UNKNOWN_ASSUME_BILLED"];
  if (!valid.includes(billed)) {
    process.stderr.write(`--billed must be one of ${valid.join(", ")}\n`);
    process.exit(2);
  }
  const store = new ScoringStateStore({ root });
  const state = await store.inspectSlot(slotId);
  const record = await store.recordAdjudication({
    slotId,
    generation: state.generation,
    attemptId,
    operator,
    billedDetermination: billed as
      | "CONFIRMED_BILLED"
      | "CONFIRMED_NOT_BILLED"
      | "UNKNOWN_ASSUME_BILLED",
    allowRetry: allowRetry === "true",
    reason,
  });
  header("ambiguous attempt adjudication");
  out(`slot:      ${record.slotId}`);
  out(`attempt:   ${record.attemptId}`);
  out(`billed:    ${record.billedDetermination}`);
  out(`allowRetry:${record.allowRetry}`);
  out("the ambiguous intent record is preserved; adjudication resolves it, never erases it");
};

// -------------------------------------------------------------- aggregate

const commandAggregate = async (): Promise<void> => {
  const root = requireCampaign();
  const store = new ScoringStateStore({ root });
  const scheduleOutcome = await store.readSchedule();
  if (scheduleOutcome.status !== "OK") {
    process.stderr.write("campaign schedule unreadable; run init first\n");
    process.exit(1);
  }
  const schedule = scheduleOutcome.record.payload;
  const states = await store.inspectAll(schedule);
  const frozenTaskIds = await loadFrozenTaskIds(repoRoot);

  const analysis = runFrozenAnalysis({
    states,
    frozenTaskIds,
    taskIds: schedule.slots
      .map((slot) => slot.taskId)
      .filter((id, i, all) => all.indexOf(id) === i),
    runsPerTask: schedule.runsPerTask,
    expectedSlots: schedule.slots.length,
    allowFinal: flag("allow-final"),
  });

  if (flag("json")) {
    out(JSON.stringify(analysis, null, 2));
    return;
  }

  const pct = (value: number | null): string =>
    value === null ? "N/A" : `${(value * 100).toFixed(2)}%`;

  header(`scoring analysis [${analysis.reportStatus}]`);
  out(
    `analysis spec: ${analysis.analysisTag} v${analysis.analysisVersion} (${analysis.analysisSha})`,
  );
  out(`STATUS: ${analysis.reportStatus} -- ${analysis.stoppingDecisionUse}`);
  out(`observations: ${analysis.completedSlots} / ${analysis.expectedSlots}`);
  out();
  out("PRIMARY METRIC -- DVS_RATE_AMONG_VALID_RUNS (run level, per-arm denominators):");
  const runLevelLine = (label: string, metric: typeof analysis.runLevel.native): string =>
    `  ${label} ${metric.dvsCount}/${metric.validRuns} valid = ${pct(metric.rate)} ` +
    `(invalid ${metric.invalidRuns})`;
  out(runLevelLine("NATIVE", analysis.runLevel.native));
  out(runLevelLine("MAF   ", analysis.runLevel.maf));
  out();
  out("TASK-LEVEL CELLS (Analysis v1 aggregation):");
  const cellLine = (label: string, cells: typeof analysis.taskLevelDescriptive.native): string =>
    `  ${label} determinate=${cells.determinateCells} dvs=${cells.dvsCells} ` +
    `unresolved=${cells.unresolvedCells} invalid=${cells.invalidCells} ` +
    `unobserved=${cells.unobservedCells}`;
  out(cellLine("NATIVE", analysis.taskLevelDescriptive.native));
  out(cellLine("MAF   ", analysis.taskLevelDescriptive.maf));
  out();
  out("PAIRED INFERENCE (task = pairing unit):");
  out(
    `  eligible tasks=${analysis.pairedInference.eligibleTaskCount} ` +
      `excluded=${analysis.pairedInference.excludedTaskCount}`,
  );
  const mc = analysis.pairedInference.mcnemar;
  out(
    mc === null
      ? "  McNemar: not computed (no eligible pairs)"
      : `  McNemar: n11=${mc.n11} n10=${mc.n10} n01=${mc.n01} n00=${mc.n00} ` +
          `discordant=${mc.discordantPairs} p=${mc.pValue.toFixed(6)}` +
          (mc.zeroDiscordance ? " (zero discordance; NOT evidence of equivalence)" : ""),
  );
  const ci = analysis.pairedInference.differenceInterval;
  out(
    ci.status === "DETERMINED"
      ? `  Difference (MAF-Native)=${ci.estimate.toFixed(6)} ` +
          `95% CI [${ci.lower.toFixed(6)}, ${ci.upper.toFixed(6)}] via ${ci.method}`
      : `  Difference CI: INAPPLICABLE -- ${ci.reason}`,
  );
  out();
  if (analysis.excludedObservations.length > 0) {
    out(`excluded observations: ${analysis.excludedObservations.length}`);
    for (const excluded of analysis.excludedObservations.slice(0, 5)) {
      out(`  - ${excluded.taskId}: ${excluded.reason}`);
    }
  }
  for (const note of analysis.notes) out(`note: ${note}`);
};

// ------------------------------------------------------------------- main

const main = async (): Promise<void> => {
  switch (command) {
    case "plan":
      return commandPlan();
    case "validate":
      return commandValidate();
    case "init":
      return commandInit();
    case "status":
      return commandStatus();
    case "next":
      return commandNext();
    case "execute":
      return commandExecute();
    case "batch-plan":
      return commandBatchPlan();
    case "resume":
      return commandResume();
    case "request-rerun":
      return commandRequestRerun();
    case "adjudicate":
      return commandAdjudicate();
    case "aggregate":
      return commandAggregate();
    default:
      header("commands");
      out("  plan           print the deterministic 174-run schedule (no provider calls)");
      out("  validate       post-freeze frozen-artifact + schedule + manifest validation");
      out("  init           create a campaign state directory");
      out("  resume         reopen an existing campaign after validating its frozen identity");
      out("  status         operational progress and spend (never a DVS trend)");
      out("  next           the next pending slots in frozen order");
      out("  batch-plan     dry plan for the next task-sized batch (3 NATIVE + 3 MAF), no calls");
      out(
        "  execute        evaluate the billed scoring gate (refuses while the runner is unfrozen)",
      );
      out("  request-rerun  explicitly authorize ONE infrastructure rerun of a slot");
      out("  adjudicate     record a human decision about a possibly-billed ambiguous attempt");
      out("  aggregate      run the frozen statistical plan over recorded observations");
      if (command !== "help") process.exitCode = 2;
  }
};

await main();
