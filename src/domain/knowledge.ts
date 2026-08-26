import { createHash } from "node:crypto";
import type {
  KnowledgeRecord,
  KnowledgeResolutionInput,
  KnowledgeResolutionResult,
  KnowledgeResolutionState,
  RepositorySnapshot,
} from "./ports";

export const MAX_KNOWLEDGE_EVIDENCE_IDS = 256;
export const MAX_KNOWLEDGE_STALENESS_INPUTS = 256;
export const DEFAULT_PROJECT_BRAIN_PAGE_SIZE = 100;
export const MAX_PROJECT_BRAIN_PAGE_SIZE = 500;
export const MAX_PROJECT_BRAIN_RECONCILE_RECORDS = 2_000;

const kinds = new Set(["FACT", "INFERENCE", "EVIDENCE", "DECISION"]);
const statuses = new Set(["ACTIVE", "STALE", "CONFLICTED"]);
const producers = new Set(["LOCAL_REPOSITORY_INDEX", "VERIFIED_RUN", "EXPLICIT_PROJECT_ASSERTION"]);
const sources = new Set(["REPOSITORY_SNAPSHOT", "VERIFICATION", "USER_ASSERTION"]);

const boundedText = (label: string, value: string, max: number): void => {
  if (value.length === 0 || value.length > max) {
    throw new Error(`${label} must contain between 1 and ${max} characters`);
  }
};

const digest = (label: string, value: string): void => {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
};

const normalizedStalenessInputs = (
  record: KnowledgeRecord,
): NonNullable<KnowledgeRecord["stalenessInputs"]> | undefined => {
  if (record.stalenessInputs === undefined) return undefined;
  if (record.stalenessInputs.length === 0) return undefined;
  if (record.stalenessInputs.length > MAX_KNOWLEDGE_STALENESS_INPUTS) {
    throw new Error(`Knowledge staleness inputs exceed ${MAX_KNOWLEDGE_STALENESS_INPUTS} records`);
  }
  const canonical = record.stalenessInputs.map((input) => {
    if (input.type === "SOURCE_DIGEST") {
      boundedText("Knowledge source dependency URI", input.uri, 2_000);
      digest("Knowledge source dependency digest", input.digest);
      return { ...input };
    }
    boundedText("Knowledge module dependency", input.module, 2_000);
    digest("Knowledge module membership digest", input.digest);
    return { ...input };
  });
  return [
    ...new Map(
      canonical.map((input) => [
        input.type === "SOURCE_DIGEST" ? `source:${input.uri}` : `module:${input.module}`,
        input,
      ]),
    ).values(),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
};

/** Runtime validation shared by memory and durable adapters; types alone do not protect DB rows. */
export const normalizeKnowledgeRecord = (input: KnowledgeRecord): KnowledgeRecord => {
  boundedText("Knowledge id", input.id, 200);
  boundedText("Knowledge project", input.projectId, 8_192);
  boundedText("Knowledge revision", input.revision, 512);
  boundedText("Knowledge statement", input.statement, 4_000);
  if (!kinds.has(input.kind)) throw new Error(`Unsupported knowledge kind: ${input.kind}`);
  if (!statuses.has(input.status)) throw new Error(`Unsupported knowledge status: ${input.status}`);
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Knowledge createdAt must be an ISO-compatible timestamp");
  }
  if (!producers.has(input.provenance.producer)) {
    throw new Error(`Unsupported knowledge producer: ${input.provenance.producer}`);
  }
  if (!sources.has(input.provenance.source)) {
    throw new Error(`Unsupported knowledge source: ${input.provenance.source}`);
  }
  boundedText("Knowledge source id", input.provenance.sourceId, 2_000);
  digest("Knowledge source digest", input.provenance.sourceDigest);
  if (input.provenance.runId !== undefined) {
    boundedText("Knowledge run id", input.provenance.runId, 200);
  }
  if (input.evidenceIds.length > MAX_KNOWLEDGE_EVIDENCE_IDS) {
    throw new Error(`Knowledge evidence references exceed ${MAX_KNOWLEDGE_EVIDENCE_IDS} records`);
  }
  for (const evidenceId of input.evidenceIds) boundedText("Knowledge evidence id", evidenceId, 512);
  const evidenceIds = [...new Set(input.evidenceIds)].sort();
  if (input.kind === "FACT" && evidenceIds.length === 0) {
    throw new Error("Facts require at least one evidence record");
  }
  const stalenessInputs = normalizedStalenessInputs(input);
  if (input.scope) {
    boundedText("Knowledge scope identity", input.scope.identity, 2_000);
    const scopeKind: unknown = (input.scope as { kind: unknown }).kind;
    if (scopeKind !== "FILE" && scopeKind !== "MODULE") {
      throw new Error(`Unsupported knowledge scope: ${String(scopeKind)}`);
    }
  }
  if (input.compilation) {
    if (
      input.compilation.schemaVersion !== 1 ||
      input.compilation.kind !== "MODULE_BOUNDARY" ||
      input.compilation.method !== "DETERMINISTIC_REPOSITORY_INDEX"
    ) {
      throw new Error("Unsupported knowledge compilation metadata");
    }
    boundedText("Knowledge compilation subject", input.compilation.subject, 2_000);
    const membershipBound = stalenessInputs?.some(
      (binding) => binding.type === "MODULE_MEMBERSHIP" && binding.module === input.scope?.identity,
    );
    if (
      input.kind !== "FACT" ||
      input.scope?.kind !== "MODULE" ||
      !stalenessInputs?.length ||
      !membershipBound
    ) {
      throw new Error("Compiled module knowledge requires a scoped FACT with staleness inputs");
    }
  }
  return structuredClone({
    ...input,
    evidenceIds,
    ...(stalenessInputs === undefined ? {} : { stalenessInputs }),
  });
};

/** Stable natural identity; createdAt/status are lifecycle metadata, not claim identity. */
export const knowledgeIdentityDigest = (input: KnowledgeRecord): string => {
  const record = normalizeKnowledgeRecord(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: record.projectId,
        revision: record.revision,
        kind: record.kind,
        statement: record.statement,
        evidenceIds: record.evidenceIds,
        provenance: {
          producer: record.provenance.producer,
          source: record.provenance.source,
          sourceId: record.provenance.sourceId,
          sourceDigest: record.provenance.sourceDigest,
        },
        stalenessInputs: record.stalenessInputs ?? null,
        scope: record.scope ?? null,
        compilation: record.compilation ?? null,
      }),
    )
    .digest("hex");
};

export const knowledgeRecordId = (input: Omit<KnowledgeRecord, "id">): string => {
  const placeholder: KnowledgeRecord = { ...input, id: "knowledge-identity-placeholder" };
  return `knowledge-${knowledgeIdentityDigest(placeholder)}`;
};

export const boundedKnowledgeLimit = (limit = DEFAULT_PROJECT_BRAIN_PAGE_SIZE): number => {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Knowledge page limit must be >= 0");
  return Math.min(limit, MAX_PROJECT_BRAIN_PAGE_SIZE);
};

export const moduleMembershipDigest = (module: string, files: string[]): string =>
  createHash("sha256")
    .update(`${module}\n${[...new Set(files)].sort().join("\n")}`)
    .digest("hex");

export const knowledgeResolutionBasis = (
  snapshot: RepositorySnapshot,
  modules?: string[],
): Pick<KnowledgeResolutionInput, "sourceDigests" | "moduleMembershipDigests"> => ({
  sourceDigests: Object.fromEntries(snapshot.evidence.map((entry) => [entry.uri, entry.digest])),
  moduleMembershipDigests: Object.fromEntries(
    (modules
      ? modules.map((module) => [module, snapshot.moduleMap[module] ?? []] as const)
      : Object.entries(snapshot.moduleMap)
    ).map(([module, files]) => [module, moduleMembershipDigest(module, files)]),
  ),
});

const stateFromBindings = (
  record: KnowledgeRecord,
  input: KnowledgeResolutionInput,
): KnowledgeResolutionState => {
  if (record.status === "STALE") return "STALE";
  if (record.status === "CONFLICTED") return "CONFLICTED";
  if (!record.stalenessInputs?.length) {
    return record.revision === input.revision ? "UNKNOWN" : "STALE";
  }
  let missing = false;
  for (const binding of record.stalenessInputs) {
    const current =
      binding.type === "SOURCE_DIGEST"
        ? input.sourceDigests[binding.uri]
        : input.moduleMembershipDigests[binding.module];
    if (current === undefined) missing = true;
    else if (current !== binding.digest) return "STALE";
  }
  return missing ? "UNKNOWN" : "CURRENT";
};

/**
 * MAF-owned resolution. Backends supply rows; revision, freshness, dependency and conflict rules
 * are identical whether the rows came from memory or PostgreSQL.
 */
export const classifyKnowledgeRecords = (
  records: KnowledgeRecord[],
  input: KnowledgeResolutionInput,
): Map<string, KnowledgeResolutionState> => {
  const states = new Map(
    records.map((record) => [record.id, stateFromBindings(record, input)] as const),
  );
  const bySubject = new Map<string, KnowledgeRecord[]>();
  for (const record of records) {
    if (states.get(record.id) !== "CURRENT" || !record.compilation) continue;
    const subject = record.compilation.subject;
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), record]);
  }
  for (const subjectRecords of bySubject.values()) {
    if (new Set(subjectRecords.map((record) => record.statement)).size <= 1) continue;
    for (const record of subjectRecords) states.set(record.id, "CONFLICTED");
  }
  return states;
};

export const resolveKnowledgeRecords = (
  records: KnowledgeRecord[],
  input: KnowledgeResolutionInput,
  sourceTruncated = false,
): KnowledgeResolutionResult => {
  const normalized = records.map(normalizeKnowledgeRecord);
  const states = classifyKnowledgeRecords(normalized, input);
  if (sourceTruncated) {
    // A bounded read that could have omitted a conflicting claim cannot safely publish any
    // compiled/current claim from that incomplete candidate set.
    for (const [id, state] of states) if (state === "CURRENT") states.set(id, "UNKNOWN");
  }
  const requestedIds = input.ids ? new Set(input.ids) : undefined;
  const requestedKinds = input.kinds ? new Set(input.kinds) : undefined;
  const relevant = normalized.filter(
    (record) =>
      record.projectId === input.projectId &&
      (!requestedIds || requestedIds.has(record.id)) &&
      (!requestedKinds || requestedKinds.has(record.kind)),
  );
  const currentCandidates = relevant
    .filter((record) => states.get(record.id) === "CURRENT")
    .sort(
      (left, right) =>
        Number(right.revision === input.revision) - Number(left.revision === input.revision) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  const seenCompiledClaims = new Set<string>();
  const deduplicated = input.ids
    ? currentCandidates
    : currentCandidates.filter((record) => {
        if (!record.compilation) return true;
        const key = `${record.compilation.subject}\u0000${record.statement}`;
        if (seenCompiledClaims.has(key)) return false;
        seenCompiledClaims.add(key);
        return true;
      });
  const limit = boundedKnowledgeLimit(input.limit);
  return {
    current: deduplicated.slice(0, limit).map((record) => structuredClone(record)),
    staleIds: relevant
      .filter((record) => states.get(record.id) === "STALE")
      .map((record) => record.id),
    unknownIds: relevant
      .filter((record) => states.get(record.id) === "UNKNOWN")
      .map((record) => record.id),
    conflictedIds: relevant
      .filter((record) => states.get(record.id) === "CONFLICTED")
      .map((record) => record.id),
    examined: relevant.length,
    truncated: sourceTruncated || deduplicated.length > limit,
  };
};
