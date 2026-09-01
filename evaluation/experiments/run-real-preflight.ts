// Real-provider preflight for the Native-vs-MAF Protocol v2 experiment plumbing.
//
// SAFETY GATE: without --confirm-billed-run this script NEVER invokes a real provider. It validates
// configuration, checks Claude Code CLI availability without a model call, builds the controller-
// owned synthetic workspaces, constructs the real Native and MAF executors and the independent
// verifier, prints the planned executions, and stops. Nothing past that point runs unless the flag
// is explicitly present on the command line.
//
// Usage:
//   tsx evaluation/experiments/run-real-preflight.ts                     (validate + stop; safe)
//   tsx evaluation/experiments/run-real-preflight.ts --confirm-billed-run (actually executes; billed)

import { execFile, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CuratorIndependentVerifier } from "../../src/evaluation/curator-verifier";
import { ExperimentRunController } from "./real/lib/experiment-run-controller";
import { ExperimentWorkspaceController } from "./real/lib/workspace-controller";
import { NativeExperimentExecutor } from "./real/lib/native-executor";
import { MafExperimentExecutor } from "./real/lib/maf-executor";
import { assertNonScoringExcluded } from "./real/lib/provenance";

const execFileAsync = promisify(execFile);
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

const checkClaudeCliAvailable = async (): Promise<{ available: boolean; detail: string }> => {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 10_000 });
    return { available: true, detail: stdout.trim() };
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

const main = async (): Promise<void> => {
  process.stdout.write("Protocol v2 real-provider preflight\n");
  process.stdout.write("====================================\n\n");

  // 1. Validate manifest/config -- delegates to the dedicated, independently-runnable validator so
  //    the two never drift.
  process.stdout.write("[1/6] Validating experiment manifest (v1/v2 equivalence)...\n");
  try {
    execFileSync("node", [path.join(realRoot, "..", "validate-manifest-v2.mjs")], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    process.stderr.write("\nPROTOCOL_V2_IMPLEMENTATION_BLOCKED: manifest validation failed.\n");
    process.exitCode = 1;
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
    process.stderr.write("\nPROTOCOL_V2_IMPLEMENTATION_BLOCKED: frozen tag resolution mismatch.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `      protocol tag ${protocolTag} -> ${protocolSha}\n      suite tag ${suiteTag} -> ${suiteSha}\n\n`,
  );

  // 2. Provider availability, without any model call.
  process.stdout.write("[2/6] Checking Claude Code CLI availability (no model call)...\n");
  const cli = await checkClaudeCliAvailable();
  process.stdout.write(
    `      claude CLI: ${cli.available ? "AVAILABLE" : "UNAVAILABLE"} (${cli.detail})\n\n`,
  );

  // 3. Build the synthetic controller-owned workspaces.
  process.stdout.write("[3/6] Building synthetic controller-owned workspaces...\n");
  const workspaces = new ExperimentWorkspaceController();
  const nativeWorkspace = await workspaces.createCandidateWorkspace(
    "NATIVE",
    preflightPristineRepo,
  );
  const mafWorkspace = await workspaces.createCandidateWorkspace("MAF", preflightPristineRepo);
  process.stdout.write(
    `      NATIVE workspace: ${nativeWorkspace}\n      MAF workspace:    ${mafWorkspace}\n\n`,
  );

  // 4. Construct the real executors (construction only -- no process is spawned by construction;
  //    ClaudeCodeAdapter only spawns the CLI when send() is called).
  process.stdout.write("[4/6] Constructing real Native and MAF executors...\n");
  const executorConfig = {
    requestedModel: manifest.modelConfiguration.model,
    effort: manifest.modelConfiguration.effort,
    provider: manifest.modelConfiguration.provider,
    timeoutMs: manifest.timeoutMs,
    budgetUsd: manifest.budget.perRunCeilingUsd,
  };
  const native = new NativeExperimentExecutor(executorConfig);
  const maf = new MafExperimentExecutor(executorConfig);
  process.stdout.write(
    "      NativeExperimentExecutor constructed (ClaudeCodeAdapter, empty preamble)\n",
  );
  process.stdout.write(
    "      MafExperimentExecutor constructed (AdaptiveModeController + ClaudeCodeAdapter)\n\n",
  );

  // 5. Construct the independent verifier.
  process.stdout.write("[5/6] Constructing the independent verifier...\n");
  const verifier = new CuratorIndependentVerifier({
    evaluationRoot: realRoot,
    locate: (taskId) => (taskId === "preflight-task" ? { phase: "preflight-phase", taskId } : null),
  });
  process.stdout.write(
    "      CuratorIndependentVerifier constructed against evaluation/experiments/real\n\n",
  );

  // 6. Show planned executions.
  process.stdout.write("[6/6] Planned executions if authorized:\n");
  process.stdout.write(
    [
      "      scope:            1 NON_SCORING NATIVE run + 1 NON_SCORING MAF run",
      `      task:             preflight-task (evaluation/experiments/real/fixtures/preflight-phase)`,
      `      model requested:  ${executorConfig.requestedModel} (effort=${executorConfig.effort}, provider=${executorConfig.provider})`,
      `      timeoutMs:        ${executorConfig.timeoutMs}`,
      `      budgetUsd/run:    ${executorConfig.budgetUsd} (HARD, via --max-budget-usd + post-hoc check)`,
      "      frozen 29-task suite: NOT touched (FRONTIER_SCORING_RUNS_EXECUTED remains NO)",
      "",
    ].join("\n"),
  );

  if (!billedConfirmed) {
    await workspaces.cleanup();
    process.stdout.write(
      "No --confirm-billed-run flag was supplied: stopping before any provider invocation.\n\n",
    );
    process.stdout.write("READY_FOR_BILLED_PREFLIGHT\n");
    return;
  }

  // Reachable only with explicit operator confirmation. The workspaces built above are discarded in
  // favor of a fresh pair allocated by the controller, which owns the full create -> run -> cleanup
  // lifecycle for the actual comparison.
  await workspaces.cleanup();
  process.stdout.write("--confirm-billed-run supplied: executing the real preflight pair now.\n\n");

  const controller = new ExperimentRunController({
    requestedModel: executorConfig.requestedModel,
    effort: executorConfig.effort,
    provider: executorConfig.provider,
    timeoutMs: executorConfig.timeoutMs,
    budgetUsd: executorConfig.budgetUsd,
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
    ) as Array<{
      id: string;
    }>
  ).map((task) => task.id);
  for (const record of provenance) assertNonScoringExcluded(record, frozenTaskIds);

  const wrapped = {
    status: "NON_SCORING" as const,
    tag: "NOT_PART_OF_EXPERIMENT" as const,
    generatedAt: new Date().toISOString(),
    note: "Real-provider preflight only. Never counted toward experiment statistics or DVS rate.",
    experimentManifest: "evaluation/experiments/native-vs-maf-v2.json",
    report,
    provenance,
  };
  const reportPath = path.join(realRoot, "preflight-report.json");
  await writeFile(reportPath, `${JSON.stringify(wrapped, null, 2)}\n`, "utf8");

  const paired = report.evaluation.paired[0];
  process.stdout.write(
    [
      "Real-provider preflight complete.",
      `  paired outcome: ${paired?.outcome ?? "NONE"}`,
      `  native executionStatus=${paired?.native.executionStatus} dvs=${paired?.native.dvs}`,
      `  maf    executionStatus=${paired?.maf.executionStatus} dvs=${paired?.maf.dvs}`,
      `  report written to ${path.relative(repoRoot, reportPath)}`,
    ].join("\n"),
  );
  process.stdout.write("\n");
};

await main();
