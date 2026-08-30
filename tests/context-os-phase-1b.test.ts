import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { ContextNavigationService } from "../src/application/context-navigation";
import { persistSelectedRepositoryKnowledge } from "../src/application/project-knowledge";
import { DEFAULT_CONTEXT_BUDGET } from "../src/domain/context";
import {
  createContextHandle,
  createInitialWorkingSet,
  rebaseWorkingSet,
  type ContextHandle,
} from "../src/domain/context-navigation";
import { moduleMembershipDigest } from "../src/domain/knowledge";
import type { ContextPageSource, KnowledgeRecord, RepositorySnapshot } from "../src/domain/ports";
import { LocalContextPageSource } from "../src/infrastructure/context-page-source";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { createFixtureRepository, type FixtureRepository } from "./helpers";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const sourceDigestA = "1".repeat(64);

const evidenceRecord = (
  id: string,
  revision = revisionA,
  overrides: Partial<KnowledgeRecord> = {},
): KnowledgeRecord => ({
  id,
  projectId: "project",
  revision,
  kind: "EVIDENCE",
  statement: `Bound source evidence ${id}`,
  evidenceIds: [],
  status: "ACTIVE",
  createdAt: "2026-08-24T00:00:00.000Z",
  provenance: {
    producer: "LOCAL_REPOSITORY_INDEX",
    source: "REPOSITORY_SNAPSHOT",
    sourceId: "src/domain/order.ts",
    sourceDigest: sourceDigestA,
  },
  stalenessInputs: [{ type: "SOURCE_DIGEST", uri: "src/domain/order.ts", digest: sourceDigestA }],
  scope: { kind: "FILE", identity: "src/domain/order.ts" },
  ...overrides,
});

const compiledFact = (id: string, statement: string): KnowledgeRecord => ({
  id,
  projectId: "project",
  revision: revisionA,
  kind: "FACT",
  statement,
  evidenceIds: ["evidence-1"],
  status: "ACTIVE",
  createdAt: "2026-08-24T00:00:00.000Z",
  provenance: {
    producer: "LOCAL_REPOSITORY_INDEX",
    source: "REPOSITORY_SNAPSHOT",
    sourceId: "src/domain",
    sourceDigest: sourceDigestA,
  },
  stalenessInputs: [
    { type: "SOURCE_DIGEST", uri: "src/domain/order.ts", digest: sourceDigestA },
    {
      type: "MODULE_MEMBERSHIP",
      module: "src/domain",
      digest: moduleMembershipDigest("src/domain", ["src/domain/order.ts"]),
    },
  ],
  scope: { kind: "MODULE", identity: "src/domain" },
  compilation: {
    schemaVersion: 1,
    kind: "MODULE_BOUNDARY",
    method: "DETERMINISTIC_REPOSITORY_INDEX",
    subject: "module:src/domain",
  },
});

const resolutionBasis = {
  sourceDigests: { "src/domain/order.ts": sourceDigestA },
  moduleMembershipDigests: {
    "src/domain": moduleMembershipDigest("src/domain", ["src/domain/order.ts"]),
  },
};

const emptySnapshot = (revision = revisionA): RepositorySnapshot => ({
  revision,
  files: [],
  filesTruncated: false,
  symbols: [],
  relations: [],
  moduleMap: {},
  moduleOwnership: {},
  packageOwnership: {},
  moduleRoots: [],
  parsedFiles: [],
  scopeTruncated: false,
  evidence: [],
});

const fileHandle = (uri: string, revision = revisionA, digest = sourceDigestA): ContextHandle =>
  createContextHandle({
    projectId: "project",
    revision,
    target: { kind: "FILE", uri, digest },
  });

const fakeSource = (content: string, status: "RESOLVED" | "UNAVAILABLE" = "RESOLVED") => {
  const resolve = vi.fn<ContextPageSource["resolve"]>(async (input) => ({
    result:
      status === "UNAVAILABLE"
        ? { status, reason: "fixture source unavailable" }
        : {
            status,
            reason: "fixture page",
            page: {
              requestKey: "source-key",
              handle: input.handle,
              operation: input.request.operation,
              content,
              relatedHandles: [],
              measuredCharacters: content.length,
              tokenMeasurement: {
                value: 999,
                precision: "EXACT",
                method: "untrusted-source-meter",
              },
              truncated: false,
              freshness: "CURRENT",
              completeness: "BOUNDED_OBSERVATION",
              authority: "CONTEXT_ONLY",
              source: "REPOSITORY_INDEX",
            },
          },
    snapshot: input.snapshot,
  }));
  return { source: { resolve } satisfies ContextPageSource, resolve };
};

describe("Context OS Phase 1b knowledge semantics", () => {
  it("publishes in-memory batches atomically and retries idempotently", async () => {
    const brain = new InMemoryProjectBrain();
    const evidence = evidenceRecord("evidence-1");
    const invalidFact = { ...compiledFact("fact-invalid", "Invalid"), evidenceIds: [] };

    await expect(brain.addBatch([evidence, invalidFact])).rejects.toThrow("Facts require");
    expect(await brain.list("project", revisionA, undefined, 10)).toEqual([]);

    const first = await brain.addBatch([evidence, compiledFact("fact-1", "Module boundary A")]);
    const retry = await brain.addBatch([evidence, compiledFact("fact-1", "Module boundary A")]);
    expect(first).toMatchObject({ inserted: 2, reactivated: 0, unchanged: 0 });
    expect(retry).toMatchObject({ inserted: 0, reactivated: 0, unchanged: 2 });
    expect(await brain.list("project", revisionA, undefined, 10)).toHaveLength(2);
  });

  it("keeps dependency-proven knowledge current across unrelated revisions and stales source changes", async () => {
    const brain = new InMemoryProjectBrain();
    await brain.addBatch([
      evidenceRecord("evidence-1"),
      compiledFact("fact-1", "Module boundary A"),
    ]);

    const unchanged = await brain.reconcileStaleness({
      projectId: "project",
      revision: revisionB,
      ...resolutionBasis,
    });
    expect(unchanged).toMatchObject({ current: 2, stale: 0, unknown: 0 });
    const current = await brain.resolveCurrent({
      projectId: "project",
      revision: revisionB,
      ...resolutionBasis,
      kinds: ["FACT"],
      limit: 10,
    });
    expect(current.current).toHaveLength(1);
    expect(current.current[0]?.revision).toBe(revisionA);

    const changed = await brain.reconcileStaleness({
      projectId: "project",
      revision: revisionB,
      sourceDigests: { "src/domain/order.ts": "2".repeat(64) },
      moduleMembershipDigests: resolutionBasis.moduleMembershipDigests,
    });
    expect(changed.stale).toBe(2);
    expect(
      (
        await brain.resolveCurrent({
          projectId: "project",
          revision: revisionB,
          sourceDigests: { "src/domain/order.ts": "2".repeat(64) },
          moduleMembershipDigests: resolutionBasis.moduleMembershipDigests,
          limit: 10,
        })
      ).current,
    ).toEqual([]);
  });

  it("keeps missing dependency evidence unknown and missing provenance conservative", async () => {
    const brain = new InMemoryProjectBrain();
    await brain.add(
      evidenceRecord("unknown-source", revisionA, {
        stalenessInputs: [
          { type: "SOURCE_DIGEST", uri: "src/domain/unparsed.ts", digest: sourceDigestA },
        ],
      }),
    );
    const unknown = await brain.resolveCurrent({
      projectId: "project",
      revision: revisionB,
      sourceDigests: {},
      moduleMembershipDigests: {},
      limit: 10,
    });
    expect(unknown.current).toEqual([]);
    expect(unknown.unknownIds).toEqual(["unknown-source"]);

    const legacy = new InMemoryProjectBrain();
    const { stalenessInputs: _ignored, ...legacyRecord } = evidenceRecord("legacy", revisionA);
    await legacy.add(legacyRecord);
    expect(
      await legacy.reconcileStaleness({
        projectId: "project",
        revision: revisionB,
        sourceDigests: {},
        moduleMembershipDigests: {},
      }),
    ).toMatchObject({ stale: 1, current: 0 });
  });

  it("marks incompatible current compiled claims conflicted instead of selecting one", async () => {
    const brain = new InMemoryProjectBrain();
    await brain.addBatch([
      evidenceRecord("evidence-1"),
      compiledFact("fact-a", "Module boundary A"),
      compiledFact("fact-b", "Module boundary B"),
    ]);
    const resolution = await brain.resolveCurrent({
      projectId: "project",
      revision: revisionA,
      ...resolutionBasis,
      kinds: ["FACT"],
      limit: 10,
    });
    expect(resolution.current).toEqual([]);
    expect(resolution.conflictedIds.sort()).toEqual(["fact-a", "fact-b"]);
    expect(
      await brain.reconcileStaleness({
        projectId: "project",
        revision: revisionA,
        ...resolutionBasis,
      }),
    ).toMatchObject({ conflicted: 2 });
  });

  it("writes deterministic compiled module knowledge through one atomic batch", async () => {
    const brain = new InMemoryProjectBrain();
    const snapshot: RepositorySnapshot = {
      ...emptySnapshot(revisionA),
      files: ["src/domain/order.ts"],
      moduleMap: { "src/domain": ["src/domain/order.ts"] },
      moduleOwnership: { "src/domain/order.ts": "src/domain" },
      packageOwnership: { "src/domain/order.ts": "root" },
      parsedFiles: ["src/domain/order.ts"],
      evidence: [{ uri: "src/domain/order.ts", digest: sourceDigestA }],
    };
    const result = await persistSelectedRepositoryKnowledge({
      brain,
      projectId: "project",
      revision: revisionA,
      runId: "run-1",
      snapshot,
      selectedFiles: ["src/domain/order.ts"],
    });
    expect(result).toMatchObject({ attempted: 2, inserted: 2 });
    const fact = (await brain.list("project", revisionA, ["FACT"], 10))[0];
    expect(fact).toMatchObject({
      compilation: {
        kind: "MODULE_BOUNDARY",
        method: "DETERMINISTIC_REPOSITORY_INDEX",
      },
      scope: { kind: "MODULE", identity: "src/domain" },
    });
  });
});

describe("Context OS Phase 1b navigation and Working Set", () => {
  let fixture: FixtureRepository | undefined;
  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("pages an exact file slice through the existing indexScope and expands resident context", async () => {
    fixture = await createFixtureRepository();
    const index = new LocalRepositoryIndex();
    const cheap = await index.index(fixture.path, revisionA);
    const snapshot = await index.indexScope(fixture.path, revisionA, cheap, ["index.ts"]);
    const digest = snapshot.evidence.find((entry) => entry.uri === "index.ts")?.digest;
    expect(digest).toBeDefined();
    const handle = fileHandle("index.ts", revisionA, digest);
    const workingSet = createInitialWorkingSet({
      projectId: "project",
      revision: revisionA,
      budget: { ...DEFAULT_CONTEXT_BUDGET },
      handles: [handle],
      residentCharacters: 100,
    });
    const service = new ContextNavigationService(
      new LocalContextPageSource(index, new InMemoryProjectBrain()),
    );
    const result = await service.expand({
      repositoryPath: fixture.path,
      snapshot,
      workingSet,
      request: {
        requestId: "page-1",
        handleId: handle.id,
        operation: "FILE_SLICE",
        startLine: 1,
        lineCount: 2,
      },
    });
    expect(result.status).toBe("RESOLVED");
    expect(result.page?.content).toContain("index.ts:1-");
    expect(result.workingSet.pageCount).toBe(1);
    expect(result.workingSet.residentCharacters).toBeGreaterThan(100);
    expect(result.events.map((event) => event.type)).toEqual(["PAGE_REQUESTED", "PAGE_RESOLVED"]);
  });

  it("pages source-revalidated project knowledge and expands its evidence references", async () => {
    const brain = new InMemoryProjectBrain();
    const evidence = evidenceRecord("evidence-1");
    const fact = compiledFact("fact-1", "Module boundary A");
    await brain.addBatch([evidence, fact]);
    const snapshot: RepositorySnapshot = {
      ...emptySnapshot(revisionA),
      files: ["src/domain/order.ts"],
      moduleMap: { "src/domain": ["src/domain/order.ts"] },
      moduleOwnership: { "src/domain/order.ts": "src/domain" },
      packageOwnership: { "src/domain/order.ts": "root" },
      parsedFiles: ["src/domain/order.ts"],
      evidence: [{ uri: "src/domain/order.ts", digest: sourceDigestA }],
    };
    const handle = createContextHandle({
      projectId: "project",
      revision: revisionA,
      target: {
        kind: "KNOWLEDGE",
        recordId: fact.id,
        knowledgeKind: fact.kind,
        sourceDigest: fact.provenance.sourceDigest,
      },
    });
    const service = new ContextNavigationService(
      new LocalContextPageSource(new LocalRepositoryIndex(), brain),
    );
    const initial = createInitialWorkingSet({
      projectId: "project",
      revision: revisionA,
      budget: { ...DEFAULT_CONTEXT_BUDGET },
      handles: [handle],
      residentCharacters: 100,
    });
    const knowledge = await service.expand({
      repositoryPath: ".",
      snapshot,
      workingSet: initial,
      request: {
        requestId: "knowledge",
        handleId: handle.id,
        operation: "KNOWLEDGE_RECORD",
      },
    });
    expect(knowledge.status).toBe("RESOLVED");
    expect(knowledge.page?.content).toContain("authority=CONTEXT_ONLY");

    const evidencePage = await service.expand({
      repositoryPath: ".",
      snapshot,
      workingSet: knowledge.workingSet,
      request: {
        requestId: "evidence",
        handleId: handle.id,
        operation: "EVIDENCE_REFERENCES",
      },
    });
    expect(evidencePage.status).toBe("RESOLVED");
    expect(evidencePage.page?.content).toContain("evidence-1");
    expect(evidencePage.page?.relatedHandles[0]?.kind).toBe("EVIDENCE");
  });

  it("reuses duplicates without duplication and eventually exposes request exhaustion", async () => {
    const handle = fileHandle("src/a.ts");
    const { source, resolve } = fakeSource("bounded page");
    const service = new ContextNavigationService(source);
    let workingSet = createInitialWorkingSet({
      projectId: "project",
      revision: revisionA,
      budget: { ...DEFAULT_CONTEXT_BUDGET, maxPageRequests: 2 },
      handles: [handle],
      residentCharacters: 10,
    });
    const request = {
      requestId: "page-1",
      handleId: handle.id,
      operation: "FILE_SLICE" as const,
    };
    const first = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet,
      request,
    });
    workingSet = first.workingSet;
    const duplicate = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet,
      request: { ...request, requestId: "page-duplicate" },
    });
    expect(duplicate.status).toBe("REUSED");
    expect(duplicate.workingSet.pages).toHaveLength(1);
    expect(duplicate.events.map((event) => event.type)).toEqual([
      "PAGE_REQUESTED",
      "DUPLICATE_PAGE_REQUEST",
      "CONTEXT_REUSED",
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);

    const exhausted = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: duplicate.workingSet,
      request: { ...request, requestId: "page-after-limit" },
    });
    expect(exhausted).toMatchObject({ status: "EXHAUSTED", reason: "PAGE_REQUEST_LIMIT" });
    expect(exhausted.events[0]?.type).toBe("BUDGET_EXHAUSTED");
  });

  it("evicts resident pages deterministically when a rebase would exceed the one ceiling", async () => {
    const handle = fileHandle("src/a.ts");
    const service = new ContextNavigationService(fakeSource("12345678").source);
    const budget = { ...DEFAULT_CONTEXT_BUDGET, maxTextCharacters: 20 };
    const initial = createInitialWorkingSet({
      projectId: "project",
      revision: revisionA,
      budget,
      handles: [handle],
      residentCharacters: 10,
    });
    const expanded = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: initial,
      request: { requestId: "page", handleId: handle.id, operation: "FILE_SLICE" },
    });
    const widerBase = createInitialWorkingSet({
      projectId: "project",
      revision: revisionA,
      budget,
      handles: [handle],
      residentCharacters: 15,
    });

    const rebased = rebaseWorkingSet(expanded.workingSet, widerBase);
    expect(rebased.residentCharacters).toBeLessThanOrEqual(budget.maxTextCharacters);
    expect(rebased.pageCount).toBe(rebased.pages.length);
    expect(rebased.ledger.some((event) => event.type === "PAGE_EVICTED")).toBe(true);
  });

  it("replaces a duplicate page when the authoritative source changes", async () => {
    const handle = fileHandle("src/a.ts");
    let content = "first";
    const source = fakeSource("");
    source.resolve.mockImplementation(async (input) => ({
      result: {
        status: "RESOLVED",
        reason: "current",
        page: {
          requestKey: "source-key",
          handle: input.handle,
          operation: input.request.operation,
          content,
          relatedHandles: [],
          measuredCharacters: content.length,
          tokenMeasurement: { value: 1, precision: "EXACT", method: "fixture" },
          truncated: false,
          freshness: "CURRENT",
          completeness: "BOUNDED_OBSERVATION",
          authority: "CONTEXT_ONLY",
          source: "REPOSITORY_INDEX",
        },
      },
      snapshot: input.snapshot,
    }));
    const service = new ContextNavigationService(source.source);
    const initial = createInitialWorkingSet({
      projectId: "project",
      revision: revisionA,
      budget: { ...DEFAULT_CONTEXT_BUDGET },
      handles: [handle],
      residentCharacters: 10,
    });
    const request = { requestId: "one", handleId: handle.id, operation: "FILE_SLICE" as const };
    const first = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: initial,
      request,
    });
    content = "second";
    const refreshed = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: first.workingSet,
      request: { ...request, requestId: "two" },
    });
    expect(refreshed).toMatchObject({ status: "RESOLVED", reason: "REVALIDATED_CHANGED" });
    expect(refreshed.page?.content).toBe("second");
    expect(refreshed.workingSet.pages).toHaveLength(1);
  });

  it("allows the same request key to recover after a source failure", async () => {
    const handle = fileHandle("src/a.ts");
    const { source, resolve } = fakeSource("recovered");
    resolve.mockRejectedValueOnce(new Error("temporary source failure"));
    const service = new ContextNavigationService(source);
    const initial = createInitialWorkingSet({
      projectId: "project",
      revision: revisionA,
      budget: { ...DEFAULT_CONTEXT_BUDGET },
      handles: [handle],
      residentCharacters: 10,
    });
    const request = { requestId: "one", handleId: handle.id, operation: "FILE_SLICE" as const };
    const failed = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: initial,
      request,
    });
    expect(failed.status).toBe("REJECTED");
    const repaired = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: failed.workingSet,
      request: { ...request, requestId: "two" },
    });
    expect(repaired.status).toBe("RESOLVED");
    expect(repaired.page?.content).toBe("recovered");
  });

  it("rejects malformed untrusted page requests before calling a page source", async () => {
    const handle = fileHandle("src/a.ts");
    const { source, resolve } = fakeSource("must not be returned");
    const result = await new ContextNavigationService(source).expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: createInitialWorkingSet({
        projectId: "project",
        revision: revisionA,
        budget: { ...DEFAULT_CONTEXT_BUDGET },
        handles: [handle],
        residentCharacters: 10,
      }),
      request: { requestId: "invalid", handleId: handle.id, operation: "EXECUTE_COMMAND" } as never,
    });

    expect(result).toMatchObject({ status: "REJECTED", reason: "INVALID_REQUEST" });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "PAGE_REJECTED",
        handleId: null,
        requestId: null,
        operation: null,
      }),
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("clips oversized pages explicitly and never accepts source-supplied authority", async () => {
    const handle = fileHandle("src/a.ts");
    const { source } = fakeSource("x".repeat(500));
    const result = await new ContextNavigationService(source).expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: createInitialWorkingSet({
        projectId: "project",
        revision: revisionA,
        budget: { ...DEFAULT_CONTEXT_BUDGET },
        handles: [handle],
        residentCharacters: 10,
      }),
      request: {
        requestId: "page-clipped",
        handleId: handle.id,
        operation: "FILE_SLICE",
        maxCharacters: 80,
      },
    });
    expect(result.status).toBe("RESOLVED");
    expect(result.page).toMatchObject({ truncated: true, authority: "CONTEXT_ONLY" });
    expect(result.page?.content.length).toBeLessThanOrEqual(80);
    expect(result.page?.tokenMeasurement).toMatchObject({
      precision: "ESTIMATED",
      method: "CHARACTERS_DIVIDED_BY_4",
    });
  });

  it("keeps handle identity revision-bound and backend replacement authority-neutral", async () => {
    const oldHandle = fileHandle("src/a.ts", revisionA);
    const newHandle = fileHandle("src/a.ts", revisionB);
    expect(newHandle.id).not.toBe(oldHandle.id);

    const knowledgeHandle = createContextHandle({
      projectId: "project",
      revision: revisionA,
      target: {
        kind: "KNOWLEDGE",
        recordId: "knowledge-locator-only",
        knowledgeKind: "INFERENCE",
        sourceDigest: sourceDigestA,
      },
    });
    const resolveWith = async (content: string) =>
      new ContextNavigationService(fakeSource(content).source).expand({
        repositoryPath: ".",
        snapshot: emptySnapshot(revisionA),
        workingSet: createInitialWorkingSet({
          projectId: "project",
          revision: revisionA,
          budget: { ...DEFAULT_CONTEXT_BUDGET },
          handles: [knowledgeHandle],
          residentCharacters: 10,
        }),
        request: {
          requestId: content,
          handleId: knowledgeHandle.id,
          operation: "KNOWLEDGE_RECORD",
        },
      });
    const firstBackend = await resolveWith("backend-a");
    const replacementBackend = await resolveWith("backend-b");
    expect(firstBackend.page?.authority).toBe("CONTEXT_ONLY");
    expect(replacementBackend.page?.authority).toBe("CONTEXT_ONLY");
    expect(knowledgeHandle.kind).toBe("KNOWLEDGE");
  });

  it("enforces the successful resident-page count independently of request count", async () => {
    const firstHandle = fileHandle("src/a.ts");
    const secondHandle = fileHandle("src/b.ts", revisionA, "2".repeat(64));
    const service = new ContextNavigationService(fakeSource("page").source);
    const initial = createInitialWorkingSet({
      projectId: "project",
      revision: revisionA,
      budget: { ...DEFAULT_CONTEXT_BUDGET, maxPageCount: 1 },
      handles: [firstHandle, secondHandle],
      residentCharacters: 10,
    });
    const first = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: initial,
      request: {
        requestId: "first-page",
        handleId: firstHandle.id,
        operation: "FILE_SLICE",
      },
    });
    const exhausted = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(),
      workingSet: first.workingSet,
      request: {
        requestId: "second-page",
        handleId: secondHandle.id,
        operation: "FILE_SLICE",
      },
    });
    expect(exhausted).toMatchObject({ status: "EXHAUSTED", reason: "PAGE_COUNT_LIMIT" });
    expect(exhausted.workingSet.pages).toHaveLength(1);
  });

  it("rejects wrong-revision, unavailable, stale, and resident-budget pages explicitly", async () => {
    const oldHandle = fileHandle("src/a.ts", revisionA);
    const unavailable = fakeSource("", "UNAVAILABLE");
    const service = new ContextNavigationService(unavailable.source);
    const wrongRevision = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(revisionB),
      workingSet: createInitialWorkingSet({
        projectId: "project",
        revision: revisionB,
        budget: { ...DEFAULT_CONTEXT_BUDGET },
        handles: [oldHandle],
        residentCharacters: 10,
      }),
      request: {
        requestId: "wrong-revision",
        handleId: oldHandle.id,
        operation: "FILE_SLICE",
      },
    });
    expect(wrongRevision).toMatchObject({ status: "REJECTED", reason: "WRONG_REVISION" });
    expect(unavailable.resolve).not.toHaveBeenCalled();

    const currentHandle = fileHandle("src/a.ts", revisionA);
    const unavailableResult = await service.expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(revisionA),
      workingSet: createInitialWorkingSet({
        projectId: "project",
        revision: revisionA,
        budget: { ...DEFAULT_CONTEXT_BUDGET },
        handles: [currentHandle],
        residentCharacters: 10,
      }),
      request: {
        requestId: "unavailable",
        handleId: currentHandle.id,
        operation: "FILE_SLICE",
      },
    });
    expect(unavailableResult).toMatchObject({ status: "REJECTED", reason: "UNAVAILABLE" });

    const oversized = fakeSource("too large");
    const budgetResult = await new ContextNavigationService(oversized.source).expand({
      repositoryPath: ".",
      snapshot: emptySnapshot(revisionA),
      workingSet: createInitialWorkingSet({
        projectId: "project",
        revision: revisionA,
        budget: { ...DEFAULT_CONTEXT_BUDGET, maxTextCharacters: 12 },
        handles: [currentHandle],
        residentCharacters: 10,
      }),
      request: {
        requestId: "resident-budget",
        handleId: currentHandle.id,
        operation: "FILE_SLICE",
      },
    });
    expect(budgetResult).toMatchObject({
      status: "EXHAUSTED",
      reason: "RESIDENT_CHARACTER_BUDGET",
    });

    fixture = await createFixtureRepository();
    const index = new LocalRepositoryIndex();
    const cheap = await index.index(fixture.path, revisionA);
    const snapshot = await index.indexScope(fixture.path, revisionA, cheap, ["index.ts"]);
    const digest = snapshot.evidence.find((entry) => entry.uri === "index.ts")?.digest;
    expect(digest).toBeDefined();
    const staleHandle = fileHandle("index.ts", revisionA, digest);
    await writeFile(path.join(fixture.path, "index.ts"), "export const changed = true;\n", "utf8");
    const stale = await new ContextNavigationService(
      new LocalContextPageSource(index, new InMemoryProjectBrain()),
    ).expand({
      repositoryPath: fixture.path,
      snapshot,
      workingSet: createInitialWorkingSet({
        projectId: "project",
        revision: revisionA,
        budget: { ...DEFAULT_CONTEXT_BUDGET },
        handles: [staleHandle],
        residentCharacters: 10,
      }),
      request: {
        requestId: "stale-file",
        handleId: staleHandle.id,
        operation: "FILE_SLICE",
      },
    });
    expect(stale).toMatchObject({ status: "REJECTED", reason: "STALE" });
    expect(stale.events.at(-1)?.type).toBe("STALE_PAGE_REJECTED");
  });

  it("uses an optional exact token meter without relabeling estimates as exact", async () => {
    const builder = new GuidedContextBuilder(new InMemoryProjectBrain(), {
      name: "fixture-exact-tokenizer",
      count: () => 7,
    });
    const context = await builder.build({
      task: {
        id: "task-token",
        prompt: "bounded token seam",
        repositoryPath: "project",
        revision: revisionA,
        createdAt: "2026-08-24T00:00:00.000Z",
        verification: { command: "npm test" },
      },
      mode: "GUIDED",
      snapshot: emptySnapshot(revisionA),
      projectId: "project",
    });
    expect(context.tokenEstimate).toBe(7);
    expect(context.tokenEstimateBasis).toBe("EXACT_TOKENIZER");
    expect(context.tokenMeasurement).toEqual({
      value: 7,
      precision: "EXACT",
      method: "fixture-exact-tokenizer",
    });
  });
});
