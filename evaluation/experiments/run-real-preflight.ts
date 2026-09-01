// Real-provider preflight for the Native-vs-MAF Protocol v2 experiment plumbing.
//
// SAFETY GATE: without --confirm-billed-run this script NEVER invokes a real provider. It validates
// configuration, resolves and auth-checks the Claude Code executable without a model call, verifies
// the participant environment is not redirected through unintended provider routing, builds the
// controller-owned synthetic workspaces, constructs the real Native and MAF executors and the
// independent verifier, prints the planned executions, and stops.
//
// Usage:
//   tsx evaluation/experiments/run-real-preflight.ts                     (validate + stop; safe)
//   tsx evaluation/experiments/run-real-preflight.ts --confirm-billed-run (actually executes; billed)
//   ... --claude-path <path>   pin the exact executable to resolve, auth-check and execute
//
// BILLED SCOPE, enforced structurally rather than by convention: exactly ONE Native provider
// invocation and ONE MAF provider invocation. Both executors are constructed with
// maxProviderInvocations=1 and maxRecoveryAttempts=0, and the ledger refuses any further attempt
// BEFORE a process is created. The first billed preflight consumed three invocations against a
// two-invocation authorization because retries were only counted after the fact.

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CuratorIndependentVerifier } from "../../src/evaluation/curator-verifier";
import { ExperimentRunController } from "./real/lib/experiment-run-controller";
import { ExperimentWorkspaceController } from "./real/lib/workspace-controller";
import { NativeExperimentExecutor } from "./real/lib/native-executor";
import { MafExperimentExecutor } from "./real/lib/maf-executor";
import { assertNonScoringExcluded } from "./real/lib/provenance";
import { modelProvenanceAcceptableForPreflight } from "./real/lib/diagnostics";
import {
  checkClaudeAuth,
  checkEnvironmentRouting,
  resolveClaudeExecutable,
} from "./real/lib/preflight-gate";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const realRoot = path.join(repoRoot, "evaluation", "experiments", "real");
const preflightPristineRepo = path.join(
  realRoot,
  "fixtures",
  "preflight-phase",
  "preflight-task",
  "public",
  "repo",
);

const billedConfirmed = process.argv.includes("--confirm-billed-run");
const claudePathFlagIndex = process.argv.indexOf("--claude-path");
const claudePathOverride =
  claudePathFlagIndex === -1 ? undefined : process.argv[claudePathFlagIndex + 1];

const resolveTagCommit = (tag: string): string | null => {
  try {
    return execFileSync("git", ["rev-parse", `${tag}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};

const blocked = (reason: string): void => {
  process.stderr.write(`\nPROTOCOL_V2_IMPLEMENTATION_BLOCKED: ${reason}\n`);
  process.exitCode = 1;
};

const main = async (): Promise<void> => {
  process.stdout.write("Protocol v2 real-provider preflight\n");
  process.stdout.write("====================================\n\n");

  // 1. Manifest/config validation -- delegates to the dedicated validator so the two never drift.
  process.stdout.write("[1/8] Validating experiment manifest (v1/v2 equivalence)...\n");
  try {
    execFileSync("node", [path.join(realRoot, "..", "validate-manifest-v2.mjs")], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    blocked("manifest validation failed.");
    return;
  }

  const manifest = JSON.parse(
    await readFile(path.join(realRoot, "..", "native-vs-maf-v2.json"), "utf8"),
  ) as {
    modelConfiguration: { model: string; provider: string; effort: string };
    timeoutMs: number;
    budget: { perRunCeilingUsd: number };
    frozenSuite: { tag: string; sha: string };
  };

  const protocolTag = "maf-experiment-protocol-v1";
  const protocolSha = resolveTagCommit(protocolTag);
  const suiteTag = manifest.frozenSuite.tag;
  const suiteSha = resolveTagCommit(suiteTag);
  if (
    !protocolSha ||
    !suiteSha ||
    protocolSha !== "b183b20a08b1d4f6902bffea49fe139f80cad4e9" ||
    suiteSha !== manifest.frozenSuite.sha
  ) {
    blocked("frozen tag resolution mismatch.");
    return;
  }
  process.stdout.write(
    `      protocol tag ${protocolTag} -> ${protocolSha}\n      suite tag ${suiteTag} -> ${suiteSha}\n\n`,
  );

  // 2. Resolve the EXACT executable that will be auth-checked and later executed.
  process.stdout.write("[2/8] Resolving the Claude Code executable (no model call)...\n");
  const executable = await resolveClaudeExecutable(claudePathOverride);
  process.stdout.write(`      ${executable.detail}\n`);
  if (executable.resolved) process.stdout.write(`      version: ${executable.version}\n`);
  process.stdout.write("\n");

  // 3. Auth gate, using the SAME executable. Never a model call.
  process.stdout.write(
    "[3/8] Checking authentication on that same executable (no model call)...\n",
  );
  const auth = executable.resolved
    ? await checkClaudeAuth(executable.path as string)
    : {
        checked: false,
        loggedIn: false,
        authMethod: null,
        apiProvider: null,
        detail: "skipped: no executable was resolved",
      };
  process.stdout.write(
    `      ${auth.detail}${auth.authMethod ? ` (method=${auth.authMethod}, provider=${auth.apiProvider})` : ""}\n\n`,
  );

  // 4. Environment routing gate: the participant must not be redirected elsewhere.
  process.stdout.write("[4/8] Checking participant environment routing...\n");
  const routing = checkEnvironmentRouting();
  process.stdout.write(`      ${routing.detail}\n`);
  process.stdout.write(
    `      externalModelOverrideForwarded=${routing.externalModelOverrideForwarded} ` +
      `externalBaseUrlOverrideForwarded=${routing.externalBaseUrlOverrideForwarded} ` +
      `externalAuthTokenForwarded=${routing.externalAuthTokenForwarded}\n\n`,
  );

  // 5. Controller-owned synthetic workspaces.
  process.stdout.write("[5/8] Building synthetic controller-owned workspaces...\n");
  const workspaces = new ExperimentWorkspaceController();
  const nativeWorkspace = await workspaces.createCandidateWorkspace(
    "NATIVE",
    preflightPristineRepo,
  );
  const mafWorkspace = await workspaces.createCandidateWorkspace("MAF", preflightPristineRepo);
  process.stdout.write(
    `      NATIVE workspace: ${nativeWorkspace}\n      MAF workspace:    ${mafWorkspace}\n\n`,
  );

  // 6. Construct the real executors (construction spawns nothing).
  process.stdout.write("[6/8] Constructing real Native and MAF executors...\n");
  const executorConfig = {
    requestedModel: manifest.modelConfiguration.model,
    effort: manifest.modelConfiguration.effort,
    provider: manifest.modelConfiguration.provider,
    timeoutMs: manifest.timeoutMs,
    budgetUsd: manifest.budget.perRunCeilingUsd,
    // BILLED PREFLIGHT RULE: one authorization means one provider invocation, enforced before spawn.
    maxProviderInvocations: 1,
    maxRecoveryAttempts: 0,
    ...(executable.path ? { claudeCommand: executable.path } : {}),
  };
  new NativeExperimentExecutor(executorConfig);
  new MafExperimentExecutor(executorConfig);
  process.stdout.write(
    "      NativeExperimentExecutor constructed (ClaudeCodeAdapter, empty preamble, --effort " +
      `${executorConfig.effort})\n`,
  );
  process.stdout.write(
    "      MafExperimentExecutor constructed (AdaptiveModeController + ClaudeCodeAdapter)\n",
  );
  process.stdout.write(
    `      provider invocation ceiling: ${executorConfig.maxProviderInvocations} per arm, ` +
      `maxRecoveryAttempts=${executorConfig.maxRecoveryAttempts}\n\n`,
  );

  // 7. Independent verifier.
  process.stdout.write("[7/8] Constructing the independent verifier...\n");
  const verifier = new CuratorIndependentVerifier({
    evaluationRoot: realRoot,
    locate: (taskId) => (taskId === "preflight-task" ? { phase: "preflight-phase", taskId } : null),
  });
  process.stdout.write(
    "      CuratorIndependentVerifier constructed against evaluation/experiments/real\n\n",
  );

  // 8. Planned executions.
  process.stdout.write("[8/8] Planned executions if authorized:\n");
  process.stdout.write(
    [
      "      scope:            1 NON_SCORING NATIVE run + 1 NON_SCORING MAF run",
      "      task:             preflight-task (evaluation/experiments/real/fixtures/preflight-phase)",
      `      executable:       ${executable.path ?? "UNRESOLVED"}`,
      `      model requested:  ${executorConfig.requestedModel} (effort=${executorConfig.effort}, provider=${executorConfig.provider})`,
      `      run timeoutMs:    ${executorConfig.timeoutMs} (shared across all attempts)`,
      `      run budgetUsd:    ${executorConfig.budgetUsd} (HARD, shared across all attempts)`,
      "      max provider invocations: 1 NATIVE + 1 MAF = 2 total, enforced before spawn",
      "      frozen 29-task suite: NOT touched (FRONTIER_SCORING_RUNS_EXECUTED remains NO)",
      "",
    ].join("\n"),
  );

  const gateFailures: string[] = [];
  if (!executable.resolved) gateFailures.push("the Claude Code executable could not be resolved");
  if (!auth.loggedIn) gateFailures.push("the resolved executable is not authenticated");

  if (!billedConfirmed) {
    await workspaces.cleanup();
    process.stdout.write(
      "No --confirm-billed-run flag was supplied: stopping before any provider invocation.\n\n",
    );
    if (gateFailures.length > 0) {
      process.stdout.write("Gates that would BLOCK a billed run:\n");
      for (const failure of gateFailures) process.stdout.write(`  - ${failure}\n`);
      process.stdout.write("\nPREFLIGHT_ENVIRONMENT_REPAIR_REQUIRED\n");
      return;
    }
    process.stdout.write("READY_FOR_BILLED_PREFLIGHT\n");
    return;
  }

  // Past this point only with explicit operator confirmation.
  if (gateFailures.length > 0) {
    await workspaces.cleanup();
    process.stderr.write("Refusing to spend a billed invocation; unmet gates:\n");
    for (const failure of gateFailures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write("\nPREFLIGHT_ENVIRONMENT_REPAIR_REQUIRED\n");
    process.exitCode = 1;
    return;
  }

  await workspaces.cleanup();
  process.stdout.write("--confirm-billed-run supplied: executing the real preflight pair now.\n\n");

  const controller = new ExperimentRunController({
    requestedModel: executorConfig.requestedModel,
    effort: executorConfig.effort,
    provider: executorConfig.provider,
    timeoutMs: executorConfig.timeoutMs,
    budgetUsd: executorConfig.budgetUsd,
    maxProviderInvocations: 1,
    maxRecoveryAttempts: 0,
    ...(executable.path ? { claudeCommand: executable.path } : {}),
    protocolTag,
    protocolSha,
    suiteTag,
    suiteSha,
  });

  const { report, provenance } = await controller.runPair({
    scoringStatus: "NON_SCORING",
    taskId: "preflight-task",
    prompt: await readFile(
      path.join(realRoot, "fixtures", "preflight-phase", "preflight-task", "public", "prompt.md"),
      "utf8",
    ),
    expectedVerification: 'formatName("Ada", "Lovelace") === "Lovelace, Ada"',
    pristineRepoPath: preflightPristineRepo,
    verifier,
  });

  const frozenTaskIds = (
    JSON.parse(
      await readFile(path.join(repoRoot, "evaluation", "contracts", "tasks.json"), "utf8"),
    ) as Array<{ id: string }>
  ).map((task) => task.id);
  for (const record of provenance) assertNonScoringExcluded(record, frozenTaskIds);

  const invocationsByArm = Object.fromEntries(
    provenance.map((record) => [record.arm, record.ceilings.providerInvocationsStarted]),
  );
  const invocationsStarted = provenance.reduce(
    (total, record) => total + record.ceilings.providerInvocationsStarted,
    0,
  );
  const invocationsRefused = provenance.reduce(
    (total, record) => total + record.ceilings.providerInvocationsRefused,
    0,
  );

  const wrapped = {
    status: "NON_SCORING" as const,
    tag: "NOT_PART_OF_EXPERIMENT" as const,
    generatedAt: new Date().toISOString(),
    note: "Real-provider preflight only. Never counted toward experiment statistics or DVS rate.",
    experimentManifest: "evaluation/experiments/native-vs-maf-v2.json",
    executable: { path: executable.path, version: executable.version },
    auth: { loggedIn: auth.loggedIn, authMethod: auth.authMethod, apiProvider: auth.apiProvider },
    environmentRouting: routing,
    providerInvocations: {
      allowedPerArm: 1,
      attempted: invocationsStarted + invocationsRefused,
      started: invocationsStarted,
      refused: invocationsRefused,
      byArm: invocationsByArm,
    },
    report,
    provenance,
  };
  const reportPath = path.join(realRoot, "preflight-report.json");
  await writeFile(reportPath, `${JSON.stringify(wrapped, null, 2)}\n`, "utf8");

  const paired = report.evaluation.paired[0];
  const modelAcceptable = provenance.every((record) =>
    modelProvenanceAcceptableForPreflight({
      requestedModel: record.requestedModel,
      rawReportedModel: record.rawReportedModel,
      resolvedModel: record.resolvedModel,
      resolvedModelStatus: record.resolvedModelStatus,
      note: record.modelProvenanceNote,
    }),
  );

  process.stdout.write(
    [
      "Real-provider preflight complete.",
      `  paired outcome: ${paired?.outcome ?? "NONE"}`,
      `  native executionStatus=${paired?.native.executionStatus} dvs=${paired?.native.dvs}`,
      `  maf    executionStatus=${paired?.maf.executionStatus} dvs=${paired?.maf.dvs}`,
      `  provider invocations started=${invocationsStarted} refused=${invocationsRefused}`,
      `  model provenance acceptable: ${modelAcceptable}`,
      `  report written to ${path.relative(repoRoot, reportPath)}`,
    ].join("\n"),
  );
  process.stdout.write("\n");
};

await main();
