import { createHash } from "node:crypto";
import { knowledgeRecordId, moduleMembershipDigest } from "../domain/knowledge";
import type { KnowledgeRecord, ProjectBrain, RepositorySnapshot } from "../domain/ports";

const MAX_REPOSITORY_KNOWLEDGE_FILES = 32;

export interface RepositoryKnowledgeWriteResult {
  attempted: number;
  inserted: number;
  reactivated: number;
  unchanged: number;
  sourceFiles: number;
  sourceFilesTruncated: boolean;
}

const withKnowledgeId = (record: Omit<KnowledgeRecord, "id">): KnowledgeRecord => ({
  ...record,
  id: knowledgeRecordId(record),
});

/**
 * Session 5's deliberately narrow eligibility rule: only exact selected repository files with a
 * deterministic SHA-256 digest from RepositoryIndex may be written. Agent text, prompts, tool
 * output, inferred claims, and candidate trust state are not inputs to this function.
 */
export const persistSelectedRepositoryKnowledge = async (input: {
  brain: ProjectBrain;
  projectId: string;
  revision: string;
  runId: string;
  snapshot: RepositorySnapshot;
  selectedFiles: string[];
  createdAt?: string;
}): Promise<RepositoryKnowledgeWriteResult> => {
  const selected = new Set(input.selectedFiles);
  const eligibleEvidence = input.snapshot.evidence
    .filter((entry) => selected.has(entry.uri) && /^[a-f0-9]{64}$/u.test(entry.digest))
    .sort((left, right) => left.uri.localeCompare(right.uri));
  const sourceFilesTruncated = eligibleEvidence.length > MAX_REPOSITORY_KNOWLEDGE_FILES;
  const boundedEvidence = eligibleEvidence.slice(0, MAX_REPOSITORY_KNOWLEDGE_FILES);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const evidenceRecords = boundedEvidence.map((entry) =>
    withKnowledgeId({
      projectId: input.projectId,
      revision: input.revision,
      kind: "EVIDENCE",
      statement: `Source file ${entry.uri} has SHA-256 ${entry.digest} at repository revision ${input.revision}.`,
      evidenceIds: [],
      status: "ACTIVE",
      createdAt,
      provenance: {
        producer: "LOCAL_REPOSITORY_INDEX",
        source: "REPOSITORY_SNAPSHOT",
        sourceId: entry.uri,
        sourceDigest: entry.digest,
        runId: input.runId,
      },
      stalenessInputs: [{ type: "SOURCE_DIGEST", uri: entry.uri, digest: entry.digest }],
      scope: { kind: "FILE", identity: entry.uri },
    }),
  );
  const evidenceByFile = new Map(
    evidenceRecords.map((record) => [record.provenance.sourceId, record]),
  );
  const filesByModule = new Map<string, string[]>();
  for (const entry of boundedEvidence) {
    const module = input.snapshot.moduleOwnership[entry.uri];
    if (!module) continue;
    filesByModule.set(module, [...(filesByModule.get(module) ?? []), entry.uri]);
  }
  const factRecords = [...filesByModule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([module, files]) => {
      const sortedFiles = files.toSorted();
      const sourceDigest = createHash("sha256")
        .update(
          sortedFiles
            .map((file) => `${file}:${evidenceByFile.get(file)?.provenance.sourceDigest ?? ""}`)
            .join("\n"),
        )
        .digest("hex");
      const selectedFileSetDigest = createHash("sha256")
        .update(sortedFiles.join("\n"))
        .digest("hex");
      return withKnowledgeId({
        projectId: input.projectId,
        revision: input.revision,
        kind: "FACT",
        statement: `Module ${module} has digest-indexed selected source files: ${sortedFiles.join(", ")}.`,
        evidenceIds: sortedFiles
          .map((file) => evidenceByFile.get(file)?.id)
          .filter((id): id is string => id !== undefined),
        status: "ACTIVE",
        createdAt,
        provenance: {
          producer: "LOCAL_REPOSITORY_INDEX",
          source: "REPOSITORY_SNAPSHOT",
          sourceId: module,
          sourceDigest,
          runId: input.runId,
        },
        stalenessInputs: [
          ...sortedFiles.map((file) => ({
            type: "SOURCE_DIGEST" as const,
            uri: file,
            digest: evidenceByFile.get(file)?.provenance.sourceDigest ?? "",
          })),
          {
            type: "MODULE_MEMBERSHIP" as const,
            module,
            digest: moduleMembershipDigest(module, input.snapshot.moduleMap[module] ?? []),
          },
        ],
        scope: { kind: "MODULE", identity: module },
        compilation: {
          schemaVersion: 1,
          kind: "MODULE_BOUNDARY",
          method: "DETERMINISTIC_REPOSITORY_INDEX",
          subject: `module:${module}:selected-files:${selectedFileSetDigest}`,
        },
      });
    });
  const records = [...evidenceRecords, ...factRecords];
  const batch = await input.brain.addBatch(records);
  return {
    attempted: records.length,
    inserted: batch.inserted,
    reactivated: batch.reactivated,
    unchanged: batch.unchanged,
    sourceFiles: boundedEvidence.length,
    sourceFilesTruncated,
  };
};
