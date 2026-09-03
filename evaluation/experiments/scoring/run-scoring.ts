#!/usr/bin/env node
// MAF Scoring Runner v1 -- command line entry point.
//
// `execute` contains the COMPLETE billed scoring path: gate -> capability -> paired execution ->
// durable persistence -> per-pair budget re-check. It is written in full here on purpose. The only
// thing preventing it from spending money at this revision is external state: RUNNER_FROZEN
// requires `maf-scoring-runner-v1` to exist locally AND on origin and to peel to this exact HEAD.
// Creating and pushing that tag activates this code exactly as written -- there is no freeze-time
// source change, no flag to flip, and no second runner revision. Every other command makes zero
// provider calls.
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
  KNOWN_SOURCE_METADATA_NOTE,
  PROTOCOL_V2_SHA,
  PROTOCOL_V2_TAG,
  RUNNER_TAG,
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

/**
 * Test seam for the freeze simulation.
 *
 * The production path must be exercisable end to end BEFORE the real tag exists, otherwise the
 * only proof that tagging activates scoring would be tagging it. `--git-fixture <module>` loads a
 * module exporting `git(args, cwd)` and, optionally, `claudeCommand`/`fixtureRoot`, letting a test
 * present a simulated frozen-runner git state and a fake CLI to the REAL command composition.
 * It is inert unless explicitly passed, and it cannot make a real provider call: the executable it
 * supplies is whatever the test names.
 */
const gitFixtureModule = value("git-fixture");
let gitOverride: ((args: string[], cwd: string) => Promise<string>) | undefined;
let fixtureRootOverride: string | undefined;
let claudeCommandOverride: string | undefined;
let probeOverrides: { resolve?: unknown; checkAuth?: unknown } = {};

/** Loads the optional simulation fixture once; inert when `--git-fixture` was not supplied. */
const loadGitFixture = async (): Promise<void> => {
  if (!gitFixtureModule || gitOverride) return;
  // A Windows absolute path is not a valid ESM specifier; it must be a file:// URL.
  const fixtureUrl = gitFixtureModule.startsWith("file:")
    ? gitFixtureModule
    : pathToFileURL(path.resolve(gitFixtureModule)).href;
  const fixture = (await import(fixtureUrl)) as {
    git?: (args: string[], cwd: string) => Promise<string>;
    claudeCommand?: string;
    fixtureRoot?: string;
    resolve?: unknown;
    checkAuth?: unknown;
  };
  gitOverride = fixture.git;
  fixtureRootOverride = fixture.fixtureRoot;
  claudeCommandOverride = fixture.claudeCommand;
  probeOverrides = { resolve: fixture.resolve, checkAuth: fixture.checkAuth };
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
  await loadGitFixture();
  const store = new ScoringStateStore({ root });
  const runnerSha = await resolveRunnerTagSha(RUNNER_TAG, {
    repoRoot,
    ...(gitOverride ? { git: gitOverride } : {}),
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
    fixtureRootOverride ??
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
  await loadGitFixture();
  const pinnedRunnerSha = await resolveRunnerTagSha(RUNNER_TAG, {
    repoRoot,
    ...(gitOverride ? { git: gitOverride } : {}),
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
  const pinned = await pinClaudeExecutable({
    ...(claudePathOverride ? { preferredPath: claudePathOverride } : {}),
    ...(claudeCommandOverride ? { preferredPath: claudeCommandOverride } : {}),
    ...(probeOverrides.resolve ? { resolve: probeOverrides.resolve as never } : {}),
    ...(probeOverrides.checkAuth ? { checkAuth: probeOverrides.checkAuth as never } : {}),
  });

  const decision = await evaluateExecutionGate({
    repoRoot,
    billedConfirmed: flag("confirm-billed-scoring"),
    manifest,
    slotStates: states,
    campaignGate,
    pinnedExecutable: pinned,
    routing: checkEnvironmentRouting(),
    effectiveConfig,
    ...(gitOverride ? { git: gitOverride } : {}),
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

  const executablePath = pinned.path as string;
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
      executablePath,
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
