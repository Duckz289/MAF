import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalBoundedProcessRunner } from "../src/infrastructure/bounded-process-runner";

describe("LocalBoundedProcessRunner", () => {
  it("terminates untrusted output at the configured combined byte ceiling", async () => {
    const runner = new LocalBoundedProcessRunner(1_024);
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.outputLimitExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      1_024,
    );
  });

  it("returns categorical spawn failure without leaking the attempted path", async () => {
    const missing = "definitely-missing-capability-binary-with-secret-token";
    const result = await new LocalBoundedProcessRunner().run({
      command: missing,
      args: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      exitCode: null,
      spawnError: "process could not be started",
      outputLimitExceeded: false,
    });
    expect(JSON.stringify(result)).not.toContain(missing);
  });

  it("keeps the returned UTF-8 representation within the byte ceiling", async () => {
    const result = await new LocalBoundedProcessRunner(8).run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.alloc(8, 0xff))"],
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });

    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      8,
    );
  });

  it("does not append timeout diagnostics outside the output bound", async () => {
    const result = await new LocalBoundedProcessRunner(8).run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('12345678'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 25,
    });

    expect(result.timedOut).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      8,
    );
  });

  it("terminates descendants as part of a timed-out capability process tree", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "maf-process-tree-"));
    const pidPath = path.join(temporaryRoot, "descendant.pid");
    try {
      const parentProgram = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const result = await new LocalBoundedProcessRunner(1_024).run({
        command: process.execPath,
        args: ["-e", parentProgram],
        cwd: temporaryRoot,
        timeoutMs: 250,
      });
      const descendantPid = Number(await readFile(pidPath, "utf8"));
      const descendantIsAlive = (): boolean => {
        try {
          process.kill(descendantPid, 0);
          return true;
        } catch {
          return false;
        }
      };

      expect(result.timedOut).toBe(true);
      await vi.waitFor(() => expect(descendantIsAlive()).toBe(false), { timeout: 2_000 });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
