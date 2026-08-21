import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  type BenchmarkExecution,
  type BenchmarkExecutor,
  BenchmarkRunner,
  type BenchmarkStrategy,
} from "../src/benchmark/runner";
import type { StrategyIdentity } from "../src/domain/strategy";
import { redactSensitiveText } from "../src/domain/security";

const strategyIdentitySchema = z.object({
  adapter: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  executionMode: z.enum(["STRICT", "GUIDED", "SOLO_NATIVE", "NATIVE"]),
  qualityPreference: z.enum(["FAST", "BALANCED", "HIGH", "CRITICAL"]),
  verificationProfile: z.string().min(1),
  reviewPolicy: z.enum(["NONE", "REQUIRED"]),
  baseline: z.enum(["NATIVE_FRONTIER", "CHALLENGER"]),
});

const variantSchema = z.object({
  strategy: z.enum(["NATIVE", "MAF_ADAPTIVE"]),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  identity: strategyIdentitySchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
});

const taskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  expectedVerification: z.string().min(1),
  family: z
    .enum([
      "SMALL_MECHANICAL",
      "CROSS_MODULE_FEATURE",
      "VERIFIER_REPAIR",
      "SECURITY_SENSITIVE",
      "DATA_CONSISTENCY",
      "NETWORK_PERFORMANCE",
      "RESILIENCE_INJECTION",
      "PROVIDER_RECOVERY",
      "INSUFFICIENT_BUDGET",
      "LONG_HORIZON_EVOLUTION",
    ])
    .optional(),
  sequence: z.object({ id: z.string().min(1), checkpoint: z.number().int().positive() }).optional(),
  changeability: z
    .object({
      comparisonClass: z.string().min(1),
      workload: z.string().min(1),
      role: z.enum(["EVOLUTION", "N_PLUS_ONE"]),
    })
    .optional(),
  strategyScope: z
    .object({
      projectId: z.string().regex(/^project-[a-f0-9]{64}$/u),
      taskClass: z.string().min(1),
      riskProfile: z.string().min(1),
      qualityRequirement: z.enum(["FAST", "BALANCED", "HIGH", "CRITICAL"]),
    })
    .optional(),
});

const manifestSchema = z
  .object({
    task: taskSchema.optional(),
    tasks: z.array(taskSchema).min(1).optional(),
    variants: z.array(variantSchema).min(2),
  })
  .refine((value) => (value.task ? 1 : 0) + (value.tasks ? 1 : 0) === 1, {
    message: "Manifest requires exactly one of task or tasks",
  });

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: npm run benchmark -- <manifest.json>");
const manifest = manifestSchema.parse(
  JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
);

const executor = (
  variant: z.infer<typeof variantSchema>,
  sequenceRoot?: string,
): BenchmarkExecutor => ({
  strategy: variant.strategy as BenchmarkStrategy,
  ...(variant.identity ? { identity: variant.identity as StrategyIdentity } : {}),
  execute: async (task) => {
    const started = performance.now();
    const child = spawn(variant.command, variant.args, {
      cwd: path.resolve(variant.cwd),
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ...(sequenceRoot ? { MAF_BENCHMARK_SEQUENCE_ROOT: sequenceRoot } : {}),
        ...(task.sequence
          ? {
              MAF_BENCHMARK_SEQUENCE_ID: task.sequence.id,
              MAF_BENCHMARK_SEQUENCE_CHECKPOINT: String(task.sequence.checkpoint),
            }
          : {}),
        ...(task.family ? { MAF_BENCHMARK_FAMILY: task.family } : {}),
        MAF_BENCHMARK_TASK_ID: task.id,
      },
    });
    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    let timedOut = false;
    const appendBounded = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString();
      if (next.length <= 1_000_000) return next;
      outputExceeded = true;
      child.kill();
      return next.slice(0, 1_000_000);
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = appendBounded(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = appendBounded(stderr, chunk)));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, variant.timeoutMs);
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timeout));
    if (timedOut) throw new Error(`${variant.strategy} executor exceeded its timeout`);
    if (outputExceeded) throw new Error(`${variant.strategy} executor exceeded its output limit`);
    if (exitCode !== 0)
      throw new Error(
        `${variant.strategy} executor failed: ${redactSensitiveText(stderr).slice(0, 4_000)}`,
      );
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    const execution = JSON.parse(lines.at(-1) ?? "{}") as unknown as BenchmarkExecution;
    return { ...execution, latencyMs: performance.now() - started };
  },
});

const runner = new BenchmarkRunner();
const suiteRoot = manifest.tasks
  ? await mkdtemp(path.join(tmpdir(), "maf-benchmark-suite-"))
  : undefined;
try {
  const executors = manifest.variants.map((variant, index) =>
    executor(variant, suiteRoot ? path.join(suiteRoot, String(index)) : undefined),
  );
  if (manifest.tasks) {
    process.stdout.write(runner.serializeSuite(await runner.runSuite(manifest.tasks, executors)));
  } else if (manifest.task) {
    process.stdout.write(runner.serialize(await runner.compare(manifest.task, executors)));
  }
} finally {
  if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
}
