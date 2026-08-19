import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "adaptive-harness-smoke-"));
const repository = path.join(root, "repository");
const sandboxRoot = path.join(root, "sandboxes");
const port = 14310;

const run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });

await run("git", ["init", "-b", "main", repository], root);
await run("git", ["config", "user.email", "smoke@example.invalid"], repository);
await run("git", ["config", "user.name", "Harness Smoke"], repository);
await writeFile(path.join(repository, "README.md"), "# Smoke fixture\n");
await run("git", ["add", "."], repository);
await run("git", ["commit", "-m", "baseline"], repository);

const server = spawn(process.execPath, ["dist/node/server/main.js"], {
  cwd: process.cwd(),
  windowsHide: true,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    SANDBOX_ROOT: sandboxRoot,
    SANDBOX_RETENTION: "none",
  },
});
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start:\n${serverOutput}`);
};

const verifyDashboard = async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const html = await response.text();
  if (!response.ok || !html.includes("Adaptive Harness Control")) {
    throw new Error(`Dashboard was not served correctly: ${response.status}`);
  }
};

const create = async (expectedFile, signals) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "Execute the native fixture agent",
      repositoryPath: repository,
      verification: { expectedFile },
      signals,
    }),
  });
  if (response.status !== 202) throw new Error(await response.text());
  return response.json();
};

const waitForRun = async (id) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${id}`);
    const body = await response.json();
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(body.state)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run ${id} did not complete`);
};

const waitForEvent = async (id, type) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${id}/events?follow=false`);
    const stream = await response.text();
    if (stream.includes(`event: ${type}`)) return stream;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run ${id} did not emit ${type}`);
};

try {
  await waitForHealth();
  await verifyDashboard();
  const pass = await create("agent-output.md", {
    scopeStabilized: true,
    mechanicalRemainingWork: true,
  });
  const fail = await create("missing-proof.txt", {
    rootCauseUncertainty: 0.9,
    crossModuleEdges: 5,
  });
  const [verified, quarantined] = await Promise.all([waitForRun(pass.id), waitForRun(fail.id)]);
  if (verified.verificationState !== "VERIFIED" || verified.executionMode !== "STRICT") {
    throw new Error(`Unexpected verified result: ${JSON.stringify(verified)}`);
  }
  if (
    quarantined.verificationState !== "QUARANTINED" ||
    quarantined.executionMode !== "SOLO_NATIVE"
  ) {
    throw new Error(`Unexpected quarantined result: ${JSON.stringify(quarantined)}`);
  }
  const [stream] = await Promise.all([
    waitForEvent(pass.id, "SandboxFinalized"),
    waitForEvent(fail.id, "SandboxFinalized"),
  ]);
  if (!stream.includes("ModeChanged") || !stream.includes("VerificationChanged")) {
    throw new Error("SSE stream did not contain required lifecycle events");
  }
  process.stdout.write(
    "Smoke PASS: dashboard, VERIFIED, QUARANTINED, adaptive transitions, SSE, and worktree cleanup\n",
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\nServer output:\n${serverOutput}`,
  );
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("close", resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
