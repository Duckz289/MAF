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
import { analyzeScoringRuns, type ScoringRunSummary } from "./lib/statistics";
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
  out(
    frozen.ok && scheduleOk && manifestCheck.passed ? "SCORING_PLAN_VALID" : "SCORING_PLAN_INVALID",
  );
  if (!(frozen.ok && scheduleOk && manifestCheck.passed)) process.exitCode = 1;
};

// ------------------------------------------------------------------- init

const commandInit = async (): Promise<void> => {
  const root = requireCampaign();
  const schedule = await buildSchedule();
  const ceilingRaw = value("ceiling-usd");
  const store = new ScoringStateStore({ root });
  const runnerSha = await resolveRunnerTagSha(RUNNER_TAG, { repoRoot });

  await store.writeCampaign({
    campaignId: randomUUID(),
    createdAt: new Date().toISOString(),
    suiteTag: SUITE_TAG,
    suiteSha: SUITE_SHA,
    protocolTag: PROTOCOL_V2_TAG,
    protocolSha: PROTOCOL_V2_SHA,
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
  await store.writeSchedule(schedule);

  header("campaign initialized");
  out(`root:            ${root}`);
  out(`schedule digest: ${schedule.scheduleDigest}`);
  out(`slots:           ${schedule.slots.length}`);
  out(
    `ceiling:         ${ceilingRaw === undefined ? "NOT SET (billed scoring refused)" : `$${ceilingRaw}`}`,
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

  // Auth is NOT probed here. Probing spawns the CLI, and this mission authorizes zero provider
  // interaction; the gate treats an unprobed auth state as a failure, which is the correct
  // fail-closed default.
  const decision = await evaluateExecutionGate({
    repoRoot,
    billedConfirmed: flag("confirm-billed-scoring"),
    manifest,
    slotStates: states,
    campaignGate,
    auth: {
      loggedIn: false,
      detail:
        "authentication was not probed: this runner revision performs no provider interaction of " +
        "any kind, so it fails closed rather than reporting an unverified pass",
    },
    routing: checkEnvironmentRouting(),
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
      "No participant executor was constructed and no provider was contacted. Participant wiring " +
        `is intentionally absent from this revision until ${RUNNER_TAG} is created by an ` +
        "independent audit (mission Phase 15).",
    );
    process.exitCode = 1;
    return;
  }

  // Unreachable while the runner is unfrozen. Kept explicit so the invariant is visible in code
  // rather than implied by the gate's return value.
  out("SCORING_EXECUTION_AUTHORIZED_BUT_PARTICIPANT_WIRING_NOT_PRESENT_IN_THIS_REVISION");
  process.exitCode = 1;
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

  const runs: ScoringRunSummary[] = [];
  for (const state of states) {
    const latest = state.observations[state.observations.length - 1];
    if (!latest) continue;
    if (!frozenTaskIds.includes(latest.taskId)) continue; // NON_SCORING can never enter statistics.
    const provenance = latest.provenance as Record<string, unknown> | undefined;
    runs.push({
      taskId: latest.taskId,
      arm: latest.arm,
      replicate: latest.replicate,
      runValidity: latest.runValidity,
      infrastructureInvalid: latest.infrastructureInvalid,
      dvs: latest.dvs,
      falseSafe: Boolean(provenance?.falseSafe),
      hiddenGraderPass: provenance?.hiddenGrader === "PASS",
      regressionPass: provenance?.regression === "PASS",
      candidateIntegrityValid: provenance?.candidateIntegrity === "VALID",
      costUsd: latest.costUsd,
      costStatus: latest.costStatus,
      elapsedMs: Number(provenance?.durationMs ?? 0),
    });
  }

  const analysis = analyzeScoringRuns({
    runs,
    taskIds: schedule.slots
      .map((slot) => slot.taskId)
      .filter((id, index, all) => all.indexOf(id) === index),
    runsPerTask: schedule.runsPerTask,
    expectedSlots: schedule.slots.length,
  });

  if (flag("json")) {
    out(JSON.stringify(analysis, null, 2));
    return;
  }

  header(`scoring analysis [${analysis.reportStatus}]`);
  out(`STATUS: ${analysis.reportStatus} -- ${analysis.stoppingDecisionUse}`);
  out(`observations: ${analysis.completedSlots} / ${analysis.expectedSlots}`);
  out();
  out(
    `NATIVE  determined cells=${analysis.native.determinedCells} dvs=${analysis.native.dvsCells} rate=${analysis.native.dvsRate ?? "N/A"}`,
  );
  out(
    `MAF     determined cells=${analysis.maf.determinedCells} dvs=${analysis.maf.dvsCells} rate=${analysis.maf.dvsRate ?? "N/A"}`,
  );
  out();
  out(
    `McNemar: ${
      analysis.mcNemar.status === "DETERMINED"
        ? `p=${analysis.mcNemar.value.pValue.toFixed(6)} (${analysis.mcNemar.value.discordantPairs} discordant)`
        : `UNDERSPECIFIED -- ${analysis.mcNemar.detail}`
    }`,
  );
  out(
    `DVS-rate difference: ${
      analysis.dvsRateDifference.status === "DETERMINED"
        ? analysis.dvsRateDifference.value.toFixed(6)
        : `UNDERSPECIFIED -- ${analysis.dvsRateDifference.detail}`
    }`,
  );
  out(`Difference 95% CI:   UNDERSPECIFIED -- ${analysis.dvsRateDifferenceInterval.detail}`);
  out();
  if (analysis.underspecified.length > 0) {
    out("STATISTICS_SPEC_UNDERSPECIFIED:");
    for (const ambiguity of analysis.underspecified) {
      out(`  - ${ambiguity.id}: ${ambiguity.topic}`);
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
      out("  status         operational progress and spend (never a DVS trend)");
      out("  next           the next pending slots in frozen order");
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
