import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BenchmarkRunner,
  type BenchmarkExecution,
  type BenchmarkExecutor,
  type BenchmarkStrategy,
} from "../src/benchmark/runner";

const variantSchema = z.object({
  strategy: z.enum(["NATIVE", "MAF_ADAPTIVE"]),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
});

const manifestSchema = z.object({
  task: z.object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    expectedVerification: z.string().min(1),
  }),
  variants: z.array(variantSchema).min(2),
});

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: npm run benchmark -- <manifest.json>");
const manifest = manifestSchema.parse(
  JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
);

const executor = (variant: z.infer<typeof variantSchema>): BenchmarkExecutor => ({
  strategy: variant.strategy as BenchmarkStrategy,
  execute: async () => {
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
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) throw new Error(`${variant.strategy} executor failed: ${stderr}`);
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    const execution = JSON.parse(lines.at(-1) ?? "{}") as BenchmarkExecution;
    return { ...execution, latencyMs: performance.now() - started };
  },
});

const runner = new BenchmarkRunner();
const report = await runner.compare(manifest.task, manifest.variants.map(executor));
process.stdout.write(runner.serialize(report));
