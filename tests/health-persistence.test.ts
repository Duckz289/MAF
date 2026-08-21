import { describe, expect, it } from "vitest";

import { deriveChangeHealth, type HealthSample } from "../src/domain/health";
import { projectIdentity } from "../src/domain/project-identity";
import { emptyCost, emptyUsage, type Run, type Task } from "../src/domain/types";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";

const repositoryPath = process.cwd();
const baseRevision = "b".repeat(40);
const sample = (runId: string, timestamp: string, projectPath = repositoryPath): HealthSample => ({
  projectId: projectIdentity(projectPath),
  runId,
  timestamp,
  revision: baseRevision,
  candidateId: `candidate-${runId}`,
  candidateDigest: "a".repeat(64),
  evidenceBasis: "VERIFIED_CANDIDATE",
  structuralBasis: "BASE_REVISION",
  changeBasis: "VERIFIED_CANDIDATE_DIFF",
  change: deriveChangeHealth(""),
});

const registerVerifiedRun = async (
  store: InMemoryRunStore,
  runId: string,
  projectPath = repositoryPath,
): Promise<void> => {
  const task: Task = {
    id: `task-${runId}`,
    prompt: "fixture",
    repositoryPath: projectPath,
    revision: "HEAD",
    createdAt: "2026-08-21T00:00:00.000Z",
    verification: {},
  };
  const run: Run = {
    id: runId,
    taskId: task.id,
    state: "COMPLETED",
    executionMode: "GUIDED",
    desiredMode: "GUIDED",
    effectiveMode: "GUIDED",
    verificationState: "VERIFIED",
    agent: "fixture",
    model: "fixture",
    provider: "fixture",
    createdAt: task.createdAt,
    updatedAt: task.createdAt,
    changedFiles: [],
    cost: emptyCost(),
    usage: emptyUsage(),
    retryCount: 0,
  };
  await store.createTask(task);
  await store.createRun(run);
  await store.addArtifact({
    id: `candidate-${runId}`,
    runId,
    kind: "DIFF",
    uri: "sandbox://fixture.patch",
    digest: "a".repeat(64),
    metadata: { baseRevision },
    createdAt: task.createdAt,
  });
  await store.addVerification({
    id: `verification-${runId}`,
    runId,
    type: "command",
    state: "VERIFIED",
    output: "ok",
    startedAt: task.createdAt,
    completedAt: task.createdAt,
    candidateId: `candidate-${runId}`,
  });
};

describe("M11 in-memory health persistence", () => {
  it("preserves project/run identity and returns an ordered bounded project window", async () => {
    const store = new InMemoryRunStore();
    for (const runId of ["run-3", "run-1", "run-2"]) await registerVerifiedRun(store, runId);
    await registerVerifiedRun(store, "run-b", process.execPath);
    await store.saveHealthSample(sample("run-3", "2026-08-21T00:03:00.000Z"));
    await store.saveHealthSample(sample("run-1", "2026-08-21T00:01:00.000Z"));
    await store.saveHealthSample(sample("run-b", "2026-08-21T00:04:00.000Z", process.execPath));
    await store.saveHealthSample(sample("run-2", "2026-08-21T00:02:00.000Z"));

    const window = await store.listHealthSamples(projectIdentity(repositoryPath), 2);
    expect(window.map((entry) => [entry.projectId, entry.runId])).toEqual([
      [projectIdentity(repositoryPath), "run-2"],
      [projectIdentity(repositoryPath), "run-3"],
    ]);
    expect(await store.listHealthSamples(projectIdentity(repositoryPath), 0)).toEqual([]);
  });

  it("rejects malformed samples and duplicate run identities", async () => {
    const store = new InMemoryRunStore();
    await expect(
      store.saveHealthSample({ projectId: "project-a", runId: "run-bad" } as never),
    ).rejects.toThrow(/malformed health sample/iu);
    await registerVerifiedRun(store, "run-1");
    await store.saveHealthSample(sample("run-1", "2026-08-21T00:01:00.000Z"));
    await expect(
      store.saveHealthSample(sample("run-1", "2026-08-21T00:02:00.000Z")),
    ).rejects.toThrow(/already exists/iu);
  });

  it("rejects samples without verified run/candidate bindings", async () => {
    const store = new InMemoryRunStore();
    await expect(
      store.saveHealthSample(sample("missing", "2026-08-21T00:00:00.000Z")),
    ).rejects.toThrow(/not bound/iu);
    await registerVerifiedRun(store, "wrong-project");
    await expect(
      store.saveHealthSample({
        ...sample("wrong-project", "2026-08-21T00:00:00.000Z"),
        projectId: projectIdentity(process.execPath),
      }),
    ).rejects.toThrow(/not bound/iu);
  });

  it("redacts credential-shaped detail evidence at the store boundary", async () => {
    const store = new InMemoryRunStore();
    await registerVerifiedRun(store, "secret-run");
    const secret = `ghp_${"s".repeat(40)}`;
    const unsafe = sample("secret-run", "2026-08-21T00:00:00.000Z");
    unsafe.change = {
      ...deriveChangeHealth(""),
      unsafeTypeEscapes: 1,
      escapeDetails: [`src/${secret}.ts: unsafe type escape`],
    };
    await store.saveHealthSample(unsafe);
    expect(JSON.stringify(await store.listHealthSamples())).not.toContain(secret);
  });

  it("preserves inert special model keys through store sanitization", async () => {
    const store = new InMemoryRunStore();
    await registerVerifiedRun(store, "model-run");
    const health = sample("model-run", "2026-08-21T00:00:00.000Z");
    health.operational = {
      tokensPerTask: 0,
      retriesPerTask: 0,
      toolCallsPerTask: null,
      contextCharsPerTask: null,
      verifierFailuresPerTask: 0,
      frontierEscalationRate: 0,
      modelMix: Object.fromEntries([
        ["__proto__", 1],
        ["constructor", 1],
      ]),
      taskCount: 2,
    };
    await store.saveHealthSample(health);
    const persisted = (await store.listHealthSamples())[0]?.operational?.modelMix ?? {};
    expect(Object.hasOwn(persisted, "__proto__")).toBe(true);
    expect(persisted.__proto__).toBe(1);
    expect(persisted.constructor).toBe(1);
  });
});
