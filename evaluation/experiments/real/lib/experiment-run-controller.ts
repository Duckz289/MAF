// Top-level orchestrator: controller-owned workspaces -> real Native/MAF executors ->
// BenchmarkRunner.compare (unmodified) -> CuratorIndependentVerifier (unmodified) -> provenance.
//
// Deliberately thin. Every piece of real evaluation logic here already exists and is already
// audited (BenchmarkRunner, benchmark-bridge, CuratorIndependentVerifier); this class's only job is
// to allocate workspaces, hand them to the two real executors, and merge their side-channel
// provenance onto the NormalizedEvaluationRun the existing pipeline produces.

import {
  BenchmarkRunner,
  type BenchmarkReport,
  type BenchmarkTask,
} from "../../../../src/benchmark/runner";
import type { IndependentVerifier } from "../../../../src/evaluation/independent-verification";
import { NativeExperimentExecutor } from "./native-executor";
import { MafExperimentExecutor } from "./maf-executor";
import { ExperimentWorkspaceController } from "./workspace-controller";
import {
  buildProvenanceRecord,
  type ExperimentProvenanceRecord,
  type ScoringStatus,
} from "./provenance";

export interface ExperimentRunControllerConfig {
  requestedModel: string;
  effort: string;
  provider: string;
  timeoutMs: number;
  budgetUsd: number;
  protocolTag: string;
  protocolSha: string;
  suiteTag: string;
  suiteSha: string;
}

export interface RunPairInput {
  scoringStatus: ScoringStatus;
  taskId: string;
  prompt: string;
  expectedVerification: string;
  pristineRepoPath: string;
  verifier: IndependentVerifier;
  runNumber?: number;
  randomizationPosition?: number | null;
}

export interface RunPairResult {
  report: BenchmarkReport;
  provenance: ExperimentProvenanceRecord[];
}

export class ExperimentRunController {
  constructor(private readonly config: ExperimentRunControllerConfig) {}

  /** Runs exactly one paired Native/MAF comparison over a controller-allocated workspace pair. */
  async runPair(input: RunPairInput): Promise<RunPairResult> {
    const workspaces = new ExperimentWorkspaceController();
    try {
      const nativeWorkspace = await workspaces.createCandidateWorkspace(
        "NATIVE",
        input.pristineRepoPath,
      );
      const mafWorkspace = await workspaces.createCandidateWorkspace("MAF", input.pristineRepoPath);
      const task: BenchmarkTask = {
        id: input.taskId,
        prompt: input.prompt,
        expectedVerification: input.expectedVerification,
        candidateWorkspaces: { NATIVE: nativeWorkspace, MAF_ADAPTIVE: mafWorkspace },
      };
      const native = new NativeExperimentExecutor({
        requestedModel: this.config.requestedModel,
        effort: this.config.effort,
        provider: this.config.provider,
        timeoutMs: this.config.timeoutMs,
        budgetUsd: this.config.budgetUsd,
      });
      const maf = new MafExperimentExecutor({
        requestedModel: this.config.requestedModel,
        effort: this.config.effort,
        provider: this.config.provider,
        timeoutMs: this.config.timeoutMs,
        budgetUsd: this.config.budgetUsd,
      });
      const runner = new BenchmarkRunner();
      const report = await runner.compare(task, [native, maf], { verifier: input.verifier });
      const paired = report.evaluation.paired[0];
      if (!paired)
        throw new Error(`BenchmarkRunner produced no paired outcome for task ${task.id}`);
      const nativeSide = native.sideChannel.get(paired.native.runId);
      const mafSide = maf.sideChannel.get(paired.maf.runId);
      if (!nativeSide) {
        throw new Error(
          `Missing NATIVE executor side-channel provenance for run ${paired.native.runId}`,
        );
      }
      if (!mafSide) {
        throw new Error(`Missing MAF executor side-channel provenance for run ${paired.maf.runId}`);
      }
      const runNumber = input.runNumber ?? 1;
      const randomizationPosition = input.randomizationPosition ?? null;
      const provenance: ExperimentProvenanceRecord[] = [
        buildProvenanceRecord({
          scoringStatus: input.scoringStatus,
          protocolTag: this.config.protocolTag,
          protocolSha: this.config.protocolSha,
          suiteTag: this.config.suiteTag,
          suiteSha: this.config.suiteSha,
          runNumber,
          randomizationPosition,
          arm: "NATIVE",
          normalized: paired.native,
          side: nativeSide,
        }),
        buildProvenanceRecord({
          scoringStatus: input.scoringStatus,
          protocolTag: this.config.protocolTag,
          protocolSha: this.config.protocolSha,
          suiteTag: this.config.suiteTag,
          suiteSha: this.config.suiteSha,
          runNumber,
          randomizationPosition,
          arm: "MAF",
          normalized: paired.maf,
          side: mafSide,
        }),
      ];
      return { report, provenance };
    } finally {
      await workspaces.cleanup();
    }
  }
}
