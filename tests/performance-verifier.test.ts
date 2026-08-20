import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Run, Task } from "../src/domain/types";
import { emptyCost, emptyUsage } from "../src/domain/types";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { CommandPerformanceVerifier } from "../src/infrastructure/performance-verifier";
import { runProcess } from "../src/infrastructure/process-utils";
import { createFixtureRepository } from "./helpers";

describe("CommandPerformanceVerifier", () => {
  it("measures a real clean-baseline/candidate delta with a bounded command", async () => {
    const fixture = await createFixtureRepository();
    const sandboxProvider = new LocalWorktreeSandbox(fixture.sandboxRoot, "none");
    let sandbox: Awaited<ReturnType<LocalWorktreeSandbox["create"]>> | undefined;
    try {
      await writeFile(path.join(fixture.path, "metric.txt"), "100\n", "utf8");
      await runProcess("git", ["add", "metric.txt"], { cwd: fixture.path });
      await runProcess("git", ["commit", "-m", "performance fixture"], { cwd: fixture.path });
      sandbox = await sandboxProvider.create("performance-run", fixture.path, "HEAD");
      await writeFile(path.join(sandbox.path, "metric.txt"), "130\n", "utf8");
      const diff = await sandboxProvider.collectDiff(sandbox);
      const digest = LocalWorktreeSandbox.digest(diff);
      const command = process.platform === "win32" ? "Get-Content metric.txt" : "cat metric.txt";
      const now = new Date().toISOString();
      const task: Task = {
        id: "performance-task",
        prompt: "measure candidate",
        repositoryPath: fixture.path,
        revision: "HEAD",
        createdAt: now,
        verification: {},
        performance: {
          command,
          metric: "p95 latency",
          unit: "ms",
          maxRegressionPercent: 10,
          samples: 2,
        },
      };
      const run: Run = {
        id: "performance-run",
        taskId: task.id,
        state: "RUNNING",
        executionMode: "GUIDED",
        desiredMode: "GUIDED",
        effectiveMode: "GUIDED",
        verificationState: "VERIFIED",
        agent: "fixture",
        model: "native",
        provider: "native",
        createdAt: now,
        updatedAt: now,
        changedFiles: diff.changedFiles,
        cost: emptyCost(),
        usage: emptyUsage(),
        retryCount: 0,
      };

      const measurement = await new CommandPerformanceVerifier().measure({
        run,
        task,
        sandbox,
        candidateId: "candidate-1",
        diffDigest: digest,
      });

      expect(measurement.state, measurement.evidence.join("; ")).toBe("MEASURED");
      expect(measurement.metrics[0]).toMatchObject({ baseline: 100, candidate: 130 });
      expect(measurement.candidateId).toBe("candidate-1");
      expect(measurement.diffDigest).toBe(digest);
    } finally {
      if (sandbox) await sandboxProvider.cleanup(sandbox, "FAILED");
      await fixture.cleanup();
    }
  });
});
