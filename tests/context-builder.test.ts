import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { persistSelectedRepositoryKnowledge } from "../src/application/project-knowledge";
import { DEFAULT_CONTEXT_BUDGET } from "../src/domain/context";
import type { KnowledgeRecord, ProjectBrain, RepositorySnapshot } from "../src/domain/ports";
import type { Task } from "../src/domain/types";
import { InMemoryProjectBrain } from "../src/infrastructure/project-brain";

const task: Task = {
  id: "task-context",
  prompt: "Fix the domain order service",
  repositoryPath: "/fixture",
  revision: "revision-current",
  createdAt: "2026-08-24T00:00:00.000Z",
  verification: { command: "npm test" },
};

const snapshot = (): RepositorySnapshot => ({
  revision: task.revision,
  files: ["src/domain/order.ts", "src/application/order-service.ts", "src/web/order.ts"],
  filesTruncated: false,
  symbols: [
    { name: "Order", kind: "class", file: "src/domain/order.ts", line: 1 },
    {
      name: "OrderService",
      kind: "class",
      file: "src/application/order-service.ts",
      line: 1,
    },
  ],
  relations: [],
  moduleMap: {
    "src/application": ["src/application/order-service.ts"],
    "src/domain": ["src/domain/order.ts"],
    "src/web": ["src/web/order.ts"],
  },
  moduleOwnership: {
    "src/application/order-service.ts": "src/application",
    "src/domain/order.ts": "src/domain",
    "src/web/order.ts": "src/web",
  },
  packageOwnership: {
    "src/application/order-service.ts": "root",
    "src/domain/order.ts": "root",
    "src/web/order.ts": "root",
  },
  moduleRoots: [],
  parsedFiles: ["src/domain/order.ts", "src/application/order-service.ts"],
  scopeTruncated: false,
  evidence: [
    { uri: "src/domain/order.ts", digest: "a".repeat(64) },
    { uri: "src/application/order-service.ts", digest: "b".repeat(64) },
  ],
});

const record = (
  index: number,
  revision = task.revision,
  withStalenessInputs = true,
): KnowledgeRecord => ({
  id: `fact-${index}`,
  projectId: task.repositoryPath,
  revision,
  kind: "FACT",
  statement: `Evidence-backed repository fact ${index} ${"x".repeat(220)}`,
  evidenceIds: Array.from(
    { length: 80 },
    (_, evidenceIndex) => `evidence-${index}-${evidenceIndex}`,
  ),
  status: "ACTIVE",
  createdAt: "2026-08-24T00:00:00.000Z",
  provenance: {
    producer: "LOCAL_REPOSITORY_INDEX",
    source: "REPOSITORY_SNAPSHOT",
    sourceId: `src/domain/fact-${index}.ts`,
    sourceDigest: createHash("sha256").update(String(index)).digest("hex"),
  },
  ...(withStalenessInputs
    ? {
        stalenessInputs: [
          { type: "SOURCE_DIGEST" as const, uri: "src/domain/order.ts", digest: "a".repeat(64) },
        ],
      }
    : {}),
});

describe("bounded guided context foundation", () => {
  it("uses the existing pager without rendering or reading ProjectBrain on scope-only calls", async () => {
    let listCalls = 0;
    const brain: ProjectBrain = {
      add: async () => "INSERTED",
      addBatch: async () => ({ outcomes: [], inserted: 0, reactivated: 0, unchanged: 0 }),
      list: async () => {
        listCalls += 1;
        return [];
      },
      resolveCurrent: async () => {
        listCalls += 1;
        return {
          current: [],
          staleIds: [],
          unknownIds: [],
          conflictedIds: [],
          examined: 0,
          truncated: false,
        };
      },
      reconcileStaleness: async () => ({
        examined: 0,
        current: 0,
        stale: 0,
        unknown: 0,
        conflicted: 0,
        truncated: false,
      }),
      markStale: async () => 0,
    };
    const builder = new GuidedContextBuilder(brain);
    const request = {
      task,
      mode: "GUIDED" as const,
      snapshot: snapshot(),
      projectId: task.repositoryPath,
      runId: "run-context",
      stage: "INITIAL_SCOPE" as const,
    };
    const selection = await builder.selectInitialScope(request);
    expect(listCalls).toBe(0);
    expect(selection.initialFiles.length).toBeGreaterThan(0);
    // A reused selection makes the expensive module map unreachable during render. The old
    // build-twice path would enumerate this proxy and fail here.
    request.snapshot.moduleMap = new Proxy(request.snapshot.moduleMap, {
      ownKeys: () => {
        throw new Error("render repeated whole-project module ranking");
      },
    });

    const built = await builder.build({
      ...request,
      stage: "INITIAL_RENDER",
      selection,
    });
    expect(listCalls).toBe(1);
    expect(built.initialFiles).toEqual(selection.initialFiles);
    expect(built.ledger).toMatchObject({
      missionId: task.id,
      runId: "run-context",
      buildStage: "INITIAL_RENDER",
      sourceRevision: task.revision,
      measuredCharacters: built.text.length,
      tokenEstimateBasis: "CHARACTERS_DIVIDED_BY_4",
    });
    expect(built.ledger.entries.find((entry) => entry.category === "MODULES")?.reason).toContain(
      "ranked 3 modules",
    );
  });

  it("keeps output and evidence expansion bounded as stored knowledge grows substantially", async () => {
    const brain = new InMemoryProjectBrain();
    for (let index = 0; index < 300; index += 1) await brain.add(record(index));
    const builder = new GuidedContextBuilder(brain);
    const request = {
      task,
      mode: "GUIDED" as const,
      snapshot: snapshot(),
      projectId: task.repositoryPath,
      runId: "run-context",
      stage: "INITIAL_SCOPE" as const,
    };
    const selection = await builder.selectInitialScope(request);
    const built = await builder.build({
      ...request,
      stage: "INITIAL_RENDER",
      selection,
    });

    expect(built.text.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.maxTextCharacters);
    expect(built.handles.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.maxContextHandles);
    expect(built.handles.every((handle) => built.text.includes(handle.id))).toBe(true);
    expect(built.workingSet.handles).toEqual(built.handles);
    expect(built.workingSet.pages).toEqual([]);
    expect(built.evidenceIds).toHaveLength(DEFAULT_CONTEXT_BUDGET.maxEvidenceReferences);
    expect(built.evidenceReferencesTruncated).toBe(true);
    expect(built.contextTruncated).toBe(true);
    expect(built.ledger.truncationReasons).toEqual(
      expect.arrayContaining(["KNOWLEDGE_QUERY_BUDGET", "EVIDENCE_REFERENCE_BUDGET"]),
    );
    expect(
      built.ledger.entries.every(
        (entry) => entry.selectedItems.length <= DEFAULT_CONTEXT_BUDGET.maxLedgerItemsPerCategory,
      ),
    ).toBe(true);
  });

  it("treats an unavailable brain and an old revision as non-authoritative absence", async () => {
    const unavailable: ProjectBrain = {
      add: async () => {
        throw new Error("knowledge write unavailable");
      },
      addBatch: async () => {
        throw new Error("knowledge batch write unavailable");
      },
      list: async () => {
        throw new Error("knowledge read unavailable");
      },
      resolveCurrent: async () => {
        throw new Error("knowledge read unavailable");
      },
      reconcileStaleness: async () => {
        throw new Error("knowledge staleness unavailable");
      },
      markStale: async () => {
        throw new Error("knowledge staleness unavailable");
      },
    };
    const unavailableBuilder = new GuidedContextBuilder(unavailable);
    const unavailableContext = await unavailableBuilder.build({
      task,
      mode: "GUIDED",
      snapshot: snapshot(),
      projectId: task.repositoryPath,
    });
    expect(unavailableContext.knowledgeRead.status).toBe("UNAVAILABLE");
    expect(unavailableContext.evidenceIds).toEqual([]);
    expect(unavailableContext.text).toContain("Project knowledge is unavailable");
    expect(
      unavailableContext.ledger.entries.find((entry) => entry.category === "KNOWLEDGE")?.freshness,
    ).toBe("UNKNOWN");
    expect(
      unavailableContext.ledger.entries.find((entry) => entry.category === "EVIDENCE_REFERENCES")
        ?.availableItemCount,
    ).toBeNull();

    const brain = new InMemoryProjectBrain();
    await brain.add(record(1, "revision-old", false));
    const current = await new GuidedContextBuilder(brain).build({
      task,
      mode: "GUIDED",
      snapshot: snapshot(),
      projectId: task.repositoryPath,
    });
    expect(current.text).not.toContain("Evidence-backed repository fact 1");
    expect(current.evidenceIds).toEqual([]);
  });

  it("writes only digest-backed repository facts and deduplicates the same eligible source", async () => {
    const brain = new InMemoryProjectBrain();
    const input = {
      brain,
      projectId: task.repositoryPath,
      revision: task.revision,
      runId: "run-1",
      snapshot: snapshot(),
      selectedFiles: ["src/domain/order.ts"],
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    const first = await persistSelectedRepositoryKnowledge(input);
    const second = await persistSelectedRepositoryKnowledge({
      ...input,
      runId: "run-2",
      createdAt: "2026-08-24T01:00:00.000Z",
    });
    expect(first).toMatchObject({ attempted: 2, inserted: 2, unchanged: 0 });
    expect(second).toMatchObject({ attempted: 2, inserted: 0, unchanged: 2 });

    expect(await brain.markStale(task.repositoryPath, "revision-newer")).toBe(2);
    const revisited = await persistSelectedRepositoryKnowledge({
      ...input,
      runId: "run-3",
      createdAt: "2026-08-24T02:00:00.000Z",
    });
    expect(revisited).toMatchObject({ attempted: 2, reactivated: 2, inserted: 0 });

    const facts = await brain.list(task.repositoryPath, task.revision, ["FACT"], 100);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: "FACT",
      evidenceIds: [expect.stringMatching(/^knowledge-/u)],
      provenance: {
        producer: "LOCAL_REPOSITORY_INDEX",
        source: "REPOSITORY_SNAPSHOT",
      },
    });
    expect(JSON.stringify(facts)).not.toContain(task.prompt);
  });
});
