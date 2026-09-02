#!/usr/bin/env node
// MAF Scoring Runner v1 -- command line entry point.
//
// NO COMMAND IN THIS FILE CAN INVOKE A PROVIDER. The `execute` subcommand deliberately stops at the
// execution gate and reports its decision; it never constructs a participant executor, because the
// gate cannot authorize while `maf-scoring-runner-v1` is unfrozen. Participant wiring is added only
// after the independent audit that creates that tag, so this artifact cannot spend money today even
// if every other precondition were somehow satisfied.
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
import { fileURLToPath } from "node:url";
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
  const store = new ScoringStateStore({ root });
  const runnerSha = await resolveRunnerTagSha(RUNNER_TAG, { repoRoot });

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
  out(
    `ceiling:         ${ceilingRaw === undefined ? "NOT SET (billed scoring refused)" : `$${ceilingRaw}`}`,
  );
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

const commandExecute = async (): Promise<void> => {
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
  const pinned = await pinClaudeExecutable(
    claudePathOverride ? { preferredPath: claudePathOverride } : {},
  );

  const decision = await evaluateExecutionGate({
    repoRoot,
    billedConfirmed: flag("confirm-billed-scoring"),
    manifest,
    slotStates: states,
    campaignGate,
    auth: {
      loggedIn: pinned.loggedIn,
      apiProvider: pinned.apiProvider,
      authMethod: pinned.authMethod,
      executablePath: pinned.path,
      executableVersion: pinned.version,
      detail: pinned.detail,
    },
    routing: checkEnvironmentRouting(),
    effectiveConfig,
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
      "No participant executor was constructed and no provider was contacted. The participant " +
        "path (evaluation/experiments/scoring/lib/participant-runner.ts) is fully wired and is " +
        "exercised by tests against a fake CLI, but it is unreachable from here until every gate " +
        `above passes -- which requires ${RUNNER_TAG} to be created by an independent audit ` +
        "(mission Phase 15).",
    );
    process.exitCode = 1;
    return;
  }

  // Unreachable while the runner is unfrozen: RUNNER_FROZEN cannot pass without the tag. Kept as an
  // explicit refusal rather than a call into the participant runner so that this revision cannot
  // spend money even if every other gate were somehow satisfied.
  out("SCORING_EXECUTION_AUTHORIZED");
  out();
  out(
    "All gates passed. This development revision still declines to spawn: enabling the batch " +
      `executor is the freeze-time change that accompanies ${RUNNER_TAG}, so that the audited ` +
      "revision and the spending revision are provably the same commit.",
  );
  process.exitCode = 1;
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
