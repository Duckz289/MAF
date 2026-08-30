import { createHash } from "node:crypto";
import type { ContextBudget, ContextTokenMeasurement } from "./context";
import type { KnowledgeKind } from "./ports";

export type ContextHandleKind =
  | "FILE"
  | "SYMBOL"
  | "MODULE"
  | "REPOSITORY"
  | "KNOWLEDGE"
  | "EVIDENCE";

export type ContextHandleTarget =
  | { kind: "FILE"; uri: string; digest: string }
  | { kind: "SYMBOL"; uri: string; name: string; line: number; digest: string }
  | { kind: "MODULE"; name: string; membershipDigest: string }
  | {
      kind: "REPOSITORY";
      sourceId: string;
      sourceDigest: string;
      sourceVersion: string;
      indexedAt: string;
      completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
      languages: string[];
    }
  | {
      kind: "KNOWLEDGE" | "EVIDENCE";
      recordId: string;
      knowledgeKind: KnowledgeKind;
      sourceDigest: string;
    };

/**
 * A locator, never proof. Its revision and source binding are revalidated every time it resolves;
 * no content payload or provider-owned identifier is carried in the canonical identity.
 */
export interface ContextHandle {
  schemaVersion: 1;
  id: string;
  kind: ContextHandleKind;
  projectId: string;
  revision: string;
  label: string;
  target: ContextHandleTarget;
}

export type ContextPageOperation =
  | "FILE_SLICE"
  | "SYMBOL_SLICE"
  | "MODULE_RELATIONSHIPS"
  | "FIND_SYMBOL"
  | "FIND_DEFINITION"
  | "FIND_REFERENCES"
  | "FIND_IMPLEMENTATIONS"
  | "KNOWLEDGE_RECORD"
  | "EVIDENCE_REFERENCES";

export interface ContextPageRequest {
  requestId: string;
  handleId: string;
  operation: ContextPageOperation;
  startLine?: number;
  lineCount?: number;
  maxCharacters?: number;
  query?: string;
  language?: string;
}

export interface ContextPage {
  requestKey: string;
  handle: ContextHandle;
  operation: ContextPageOperation;
  content: string;
  relatedHandles: ContextHandle[];
  measuredCharacters: number;
  tokenMeasurement: ContextTokenMeasurement;
  truncated: boolean;
  freshness: "CURRENT";
  completeness: "BOUNDED_OBSERVATION";
  authority: "CONTEXT_ONLY";
  source: "REPOSITORY_INDEX" | "REPOSITORY_INTELLIGENCE" | "PROJECT_BRAIN";
}

export type ContextPageSourceStatus =
  | "RESOLVED"
  | "STALE"
  | "UNAVAILABLE"
  | "UNSUPPORTED"
  | "TIMEOUT"
  | "MALFORMED"
  | "PARTIAL"
  | "VERSION_MISMATCH"
  | "REJECTED";

export interface ContextPageSourceResult {
  status: ContextPageSourceStatus;
  reason: string;
  page?: ContextPage;
}

export type ContextExhaustionReason =
  | "PAGE_REQUEST_LIMIT"
  | "PAGE_COUNT_LIMIT"
  | "RESIDENT_CHARACTER_BUDGET";

export type ContextNavigationEventType =
  | "INITIAL_SELECTION"
  | "PAGE_EVICTED"
  | "PAGE_REQUESTED"
  | "PAGE_RESOLVED"
  | "PAGE_REJECTED"
  | "DUPLICATE_PAGE_REQUEST"
  | "CONTEXT_REUSED"
  | "BUDGET_EXHAUSTED"
  | "STALE_PAGE_REJECTED";

export interface ContextNavigationLedgerEvent {
  sequence: number;
  type: ContextNavigationEventType;
  timestamp: string;
  projectId: string;
  sourceRevision: string;
  handleId: string | null;
  requestId: string | null;
  requestKey: string | null;
  operation: ContextPageOperation | null;
  reason: string;
  residentCharactersBefore: number;
  residentCharactersAfter: number;
  requestCount: number;
  pageCount: number;
}

/** Mission-resident material: bounded initial selection plus explicitly resolved hot pages. */
export interface ContextWorkingSet {
  schemaVersion: 1;
  projectId: string;
  revision: string;
  budget: ContextBudget;
  handles: ContextHandle[];
  pages: ContextPage[];
  baseCharacters: number;
  residentCharacters: number;
  requestCount: number;
  pageCount: number;
  requestedKeys: string[];
  exhaustion: ContextExhaustionReason | null;
  ledger: ContextNavigationLedgerEvent[];
}

const bounded = (label: string, value: string, max: number): void => {
  if (value.length === 0 || value.length > max) {
    throw new Error(`${label} must contain between 1 and ${max} characters`);
  }
};

const validDigest = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);

const canonicalRepositoryUri = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 2_000 &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/u.test(value) &&
  !value.split("/").includes("..");

const canonicalTarget = (target: ContextHandleTarget): ContextHandleTarget => {
  if (target.kind === "FILE") {
    if (!canonicalRepositoryUri(target.uri) || !validDigest(target.digest)) {
      throw new Error("File context handles require a canonical repository URI and SHA-256 digest");
    }
    return { ...target };
  }
  if (target.kind === "SYMBOL") {
    if (
      !canonicalRepositoryUri(target.uri) ||
      !validDigest(target.digest) ||
      !Number.isInteger(target.line) ||
      target.line < 1
    ) {
      throw new Error("Symbol context handles require a bound file, digest, and positive line");
    }
    bounded("Context symbol name", target.name, 512);
    return { ...target };
  }
  if (target.kind === "MODULE") {
    bounded("Context module name", target.name, 2_000);
    if (!validDigest(target.membershipDigest)) {
      throw new Error("Module context handles require a membership digest");
    }
    return { ...target };
  }
  if (target.kind === "REPOSITORY") {
    bounded("Repository intelligence source", target.sourceId, 512);
    bounded("Repository intelligence version", target.sourceVersion, 128);
    if (!validDigest(target.sourceDigest) || !Number.isFinite(Date.parse(target.indexedAt))) {
      throw new Error("Repository context handles require a source digest and indexed timestamp");
    }
    if (!new Set(["COMPLETE", "PARTIAL", "UNKNOWN"]).has(target.completeness)) {
      throw new Error("Repository context handles require explicit source completeness");
    }
    if (target.languages.length > 64) {
      throw new Error("Repository context handles support at most 64 language identifiers");
    }
    const languages = [
      ...new Set(target.languages.map((language) => language.trim().toLowerCase())),
    ]
      .filter(Boolean)
      .sort();
    for (const language of languages) bounded("Repository intelligence language", language, 64);
    return { ...target, languages };
  }
  bounded("Context knowledge record id", target.recordId, 200);
  if (!validDigest(target.sourceDigest)) {
    throw new Error("Knowledge context handles require a source digest");
  }
  return { ...target };
};

const targetLabel = (target: ContextHandleTarget): string => {
  if (target.kind === "FILE") return target.uri;
  if (target.kind === "SYMBOL") return `${target.name} at ${target.uri}:${target.line}`;
  if (target.kind === "MODULE") return target.name;
  if (target.kind === "REPOSITORY") {
    return `semantic repository index ${target.sourceVersion} (${target.completeness.toLowerCase()})`;
  }
  return `${target.knowledgeKind} ${target.recordId}`;
};

export const createContextHandle = (input: {
  projectId: string;
  revision: string;
  target: ContextHandleTarget;
}): ContextHandle => {
  bounded("Context handle project", input.projectId, 8_192);
  bounded("Context handle revision", input.revision, 512);
  const target = canonicalTarget(input.target);
  const identity = JSON.stringify({
    schemaVersion: 1,
    projectId: input.projectId,
    revision: input.revision,
    target,
  });
  return {
    schemaVersion: 1,
    id: `context-${createHash("sha256").update(identity).digest("hex")}`,
    kind: target.kind,
    projectId: input.projectId,
    revision: input.revision,
    label: targetLabel(target),
    target,
  };
};

export const contextPageRequestKey = (request: ContextPageRequest): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        handleId: request.handleId,
        operation: request.operation,
        startLine: request.startLine ?? null,
        lineCount: request.lineCount ?? null,
        maxCharacters: request.maxCharacters ?? null,
        query: request.query ?? null,
        language: request.language ?? null,
      }),
    )
    .digest("hex");

const requestOperations = new Set<ContextPageOperation>([
  "FILE_SLICE",
  "SYMBOL_SLICE",
  "MODULE_RELATIONSHIPS",
  "FIND_SYMBOL",
  "FIND_DEFINITION",
  "FIND_REFERENCES",
  "FIND_IMPLEMENTATIONS",
  "KNOWLEDGE_RECORD",
  "EVIDENCE_REFERENCES",
]);

/** Candidate-controlled agent data enters paging only through this bounded structural parser. */
export const parseContextPageRequest = (value: unknown): ContextPageRequest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestId !== "string" ||
    record.requestId.length === 0 ||
    record.requestId.length > 200 ||
    typeof record.handleId !== "string" ||
    !/^context-[a-f0-9]{64}$/u.test(record.handleId) ||
    typeof record.operation !== "string" ||
    !requestOperations.has(record.operation as ContextPageOperation)
  ) {
    return null;
  }
  for (const key of ["startLine", "lineCount", "maxCharacters"] as const) {
    const candidate = record[key];
    if (candidate !== undefined && (!Number.isInteger(candidate) || Number(candidate) < 1)) {
      return null;
    }
  }
  if (
    (record.query !== undefined &&
      (typeof record.query !== "string" ||
        record.query.trim().length === 0 ||
        record.query.length > 512)) ||
    (record.language !== undefined &&
      (typeof record.language !== "string" ||
        record.language.trim().length === 0 ||
        record.language.length > 64)) ||
    (record.operation === "FIND_SYMBOL" && record.query === undefined)
  ) {
    return null;
  }
  return {
    requestId: record.requestId,
    handleId: record.handleId,
    operation: record.operation as ContextPageOperation,
    ...(record.startLine === undefined ? {} : { startLine: Number(record.startLine) }),
    ...(record.lineCount === undefined ? {} : { lineCount: Number(record.lineCount) }),
    ...(record.maxCharacters === undefined ? {} : { maxCharacters: Number(record.maxCharacters) }),
    ...(record.query === undefined ? {} : { query: String(record.query).trim() }),
    ...(record.language === undefined
      ? {}
      : { language: String(record.language).trim().toLowerCase() }),
  };
};

export const createInitialWorkingSet = (input: {
  projectId: string;
  revision: string;
  budget: ContextBudget;
  handles: ContextHandle[];
  residentCharacters: number;
  timestamp?: string;
}): ContextWorkingSet => {
  if (input.residentCharacters > input.budget.maxTextCharacters) {
    throw new Error("Initial Working Set exceeds the resident-context character budget");
  }
  const handles = [...new Map(input.handles.map((handle) => [handle.id, handle])).values()].slice(
    0,
    input.budget.maxContextHandles,
  );
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    revision: input.revision,
    budget: structuredClone(input.budget),
    handles,
    pages: [],
    baseCharacters: input.residentCharacters,
    residentCharacters: input.residentCharacters,
    requestCount: 0,
    pageCount: 0,
    requestedKeys: [],
    exhaustion: null,
    ledger: [
      {
        sequence: 1,
        type: "INITIAL_SELECTION",
        timestamp,
        projectId: input.projectId,
        sourceRevision: input.revision,
        handleId: null,
        requestId: null,
        requestKey: null,
        operation: null,
        reason: `Initial selection exposed ${handles.length} bounded context locator(s).`,
        residentCharactersBefore: 0,
        residentCharactersAfter: input.residentCharacters,
        requestCount: 0,
        pageCount: 0,
      },
    ],
  };
};

export const rebaseWorkingSet = (
  current: ContextWorkingSet,
  nextInitial: ContextWorkingSet,
): ContextWorkingSet => {
  if (current.projectId !== nextInitial.projectId || current.revision !== nextInitial.revision) {
    throw new Error("A Working Set cannot be rebound to another project or revision");
  }
  const handles = [
    ...new Map(
      [...nextInitial.handles, ...current.handles].map((handle) => [handle.id, handle]),
    ).values(),
  ].slice(0, nextInitial.budget.maxContextHandles);
  let residentCharacters = nextInitial.baseCharacters;
  const pages = current.pages.filter((page) => {
    if (residentCharacters + page.measuredCharacters > nextInitial.budget.maxTextCharacters) {
      return false;
    }
    residentCharacters += page.measuredCharacters;
    return true;
  });
  const evicted = current.pages.length - pages.length;
  const ledger = structuredClone(current.ledger);
  if (evicted > 0) {
    ledger.push({
      sequence: ledger.length + 1,
      type: "PAGE_EVICTED",
      timestamp: new Date().toISOString(),
      projectId: current.projectId,
      sourceRevision: current.revision,
      handleId: null,
      requestId: null,
      requestKey: null,
      operation: null,
      reason: `${evicted} resident context page(s) were evicted to satisfy the rebased budget.`,
      residentCharactersBefore: current.residentCharacters,
      residentCharactersAfter: residentCharacters,
      requestCount: current.requestCount,
      pageCount: pages.length,
    });
  }
  return {
    ...structuredClone(current),
    budget: structuredClone(nextInitial.budget),
    handles,
    pages,
    baseCharacters: nextInitial.baseCharacters,
    residentCharacters,
    pageCount: pages.length,
    requestedKeys: pages.map((page) => page.requestKey),
    exhaustion: null,
    ledger,
  };
};
