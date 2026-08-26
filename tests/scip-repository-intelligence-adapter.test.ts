import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RepositoryIntelligenceOperation,
  RepositoryIntelligenceQuery,
  RepositoryIntelligenceSymbolAnchor,
} from "../src/domain/repository-intelligence";
import {
  loadScipRepositoryIntelligenceManifest,
  parseScipRepositoryIntelligenceManifest,
  SCIP_REPOSITORY_INTELLIGENCE_CERTIFICATION,
  SCIP_SOURCE_ID,
  SCIP_SOURCE_VERSION,
  ScipRepositoryIntelligenceAdapter,
  type ScipRepositoryIntelligenceAdapterConfig,
  type ScipRepositoryIntelligenceBounds,
  type ScipRepositoryIntelligenceManifest,
} from "../src/infrastructure/providers/scip-repository-intelligence-adapter";

const fixedNow = "2026-08-24T12:00:00.000Z";
const indexedAt = "2026-08-24T11:00:00.000Z";
const baseUri = "src/base.ts";
const implementationUri = "src/implementation.ts";
const baseSymbol = "scip-typescript npm fixture 1.0.0 api/Base#run().";
const implementationSymbol =
  "scip-typescript npm fixture 1.0.0 implementation/Implementation#run().";
const canonicalDefinitionSymbol = "scip-typescript npm fixture 1.0.0 api/Canonical#run().";
const baseContent = [
  "export interface Base {",
  "  run(): void;",
  "}",
  "",
  "declare const selected: Base;",
  "selected.run();",
  "",
].join("\n");
const implementationContent = [
  "export class Implementation implements Base {",
  "  run(): void {}",
  "}",
  "",
  "const implementation = new Implementation();",
  "implementation.run();",
  "",
].join("\n");

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const concat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);

const varint = (input: number | bigint): Buffer => {
  let value = BigInt(input);
  const bytes: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0n);
  return Buffer.from(bytes);
};

const tag = (field: number, wire: number): Buffer => varint(field * 8 + wire);
const uintField = (field: number, value: number): Buffer => concat(tag(field, 0), varint(value));
const bytesField = (field: number, value: Uint8Array): Buffer =>
  concat(tag(field, 2), varint(value.byteLength), value);
const stringField = (field: number, value: string): Buffer =>
  bytesField(field, Buffer.from(value, "utf8"));
const messageField = (field: number, ...fields: Uint8Array[]): Buffer =>
  bytesField(field, concat(...fields));

const singleRange = (line: number, start: number, end: number): Buffer =>
  concat(uintField(1, line), uintField(2, start), uintField(3, end));

const multiRange = (startLine: number, start: number, endLine: number, end: number): Buffer =>
  concat(uintField(1, startLine), uintField(2, start), uintField(3, endLine), uintField(4, end));

interface OccurrenceFixture {
  symbol: string;
  roles?: number;
  legacyRange?: number[];
  typedSingleRange?: [number, number, number];
  typedMultiRange?: [number, number, number, number];
}

const occurrence = (input: OccurrenceFixture): Buffer => {
  const fields: Buffer[] = [];
  if (input.legacyRange) {
    fields.push(bytesField(1, concat(...input.legacyRange.map(varint))));
  }
  fields.push(stringField(2, input.symbol));
  if (input.roles !== undefined) fields.push(uintField(3, input.roles));
  if (input.typedSingleRange) {
    fields.push(messageField(8, singleRange(...input.typedSingleRange)));
  }
  if (input.typedMultiRange) {
    fields.push(messageField(9, multiRange(...input.typedMultiRange)));
  }
  return concat(...fields);
};

interface RelationshipFixture {
  symbol: string;
  reference?: boolean;
  implementation?: boolean;
  definition?: boolean;
}

const relationship = (input: RelationshipFixture): Buffer =>
  concat(
    stringField(1, input.symbol),
    ...(input.reference ? [uintField(2, 1)] : []),
    ...(input.implementation ? [uintField(3, 1)] : []),
    ...(input.definition ? [uintField(5, 1)] : []),
  );

const symbolInformation = (
  symbol: string,
  displayName: string,
  relationships: RelationshipFixture[] = [],
): Buffer =>
  concat(
    stringField(1, symbol),
    ...relationships.map((value) => messageField(4, relationship(value))),
    stringField(6, displayName),
  );

interface DocumentFixture {
  uri: string;
  language?: string;
  encoding?: number;
  occurrences: Buffer[];
  symbols: Buffer[];
}

const document = (input: DocumentFixture): Buffer =>
  concat(
    stringField(1, input.uri),
    ...input.occurrences.map((value) => messageField(2, value)),
    ...input.symbols.map((value) => messageField(3, value)),
    stringField(4, input.language ?? "TypeScript"),
    uintField(6, input.encoding ?? 2),
  );

const metadata = (indexerVersion = "0.4.0", protocolVersion = 0): Buffer =>
  concat(
    uintField(1, protocolVersion),
    messageField(2, stringField(1, "scip-typescript"), stringField(2, indexerVersion)),
    stringField(3, "file:///operator/worktree"),
    uintField(4, 1),
  );

const canonicalDocuments = (): Buffer[] => [
  document({
    uri: baseUri,
    occurrences: [
      occurrence({
        symbol: baseSymbol,
        roles: 1,
        typedSingleRange: [1, 2, 5],
      }),
      occurrence({ symbol: baseSymbol, legacyRange: [5, 9, 12] }),
      occurrence({ symbol: baseSymbol, legacyRange: [5, 9, 12] }),
    ],
    symbols: [symbolInformation(baseSymbol, "run")],
  }),
  document({
    uri: implementationUri,
    occurrences: [
      occurrence({
        symbol: implementationSymbol,
        roles: 1,
        typedMultiRange: [1, 2, 1, 5],
      }),
      occurrence({
        symbol: implementationSymbol,
        legacyRange: [5, 15, 18],
      }),
    ],
    symbols: [
      symbolInformation(implementationSymbol, "run", [
        {
          symbol: baseSymbol,
          reference: true,
          implementation: true,
        },
      ]),
    ],
  }),
];

const indexWithDocuments = (
  documents: Buffer[],
  indexerVersion = "0.4.0",
  protocolVersion = 0,
): Buffer =>
  concat(
    messageField(1, metadata(indexerVersion, protocolVersion)),
    ...documents.map((value) => messageField(2, value)),
  );

interface FixtureOptions {
  indexBytes?: Buffer;
  sourceVersion?: string;
  indexSha256?: string;
  indexedAt?: string;
  maxAgeMs?: number;
  expectedIndexerVersion?: string;
  documents?: ScipRepositoryIntelligenceManifest["documents"];
  bounds?: Partial<ScipRepositoryIntelligenceBounds>;
  timeoutMs?: number;
  now?: () => Date;
  readArtifact?: ScipRepositoryIntelligenceAdapterConfig["readArtifact"];
}

interface Fixture {
  root: string;
  repositoryPath: string;
  artifactPath: string;
  manifestPath: string;
  manifest: ScipRepositoryIntelligenceManifest;
  adapter: ScipRepositoryIntelligenceAdapter;
  baseDigest: string;
  implementationDigest: string;
}

const fixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "maf-scip-adapter-"));
  temporaryRoots.push(root);
  const repositoryPath = join(root, "repository");
  const manifestPath = join(root, "trusted", "scip-manifest.json");
  const artifactPath = join(dirname(manifestPath), "index.scip");
  await mkdir(join(repositoryPath, "src"), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(join(repositoryPath, ...baseUri.split("/")), baseContent, "utf8");
  await writeFile(
    join(repositoryPath, ...implementationUri.split("/")),
    implementationContent,
    "utf8",
  );
  const indexBytes = options.indexBytes ?? indexWithDocuments(canonicalDocuments());
  await writeFile(artifactPath, indexBytes);
  const baseDigest = digest(baseContent);
  const implementationDigest = digest(implementationContent);
  const manifest: ScipRepositoryIntelligenceManifest = {
    manifestVersion: 1,
    projectId: "project-1",
    revision: "revision-1",
    indexPath: "index.scip",
    indexSha256: options.indexSha256 ?? digest(indexBytes),
    sourceId: SCIP_SOURCE_ID,
    sourceVersion: options.sourceVersion ?? SCIP_SOURCE_VERSION,
    indexedAt: options.indexedAt ?? indexedAt,
    maxAgeMs: options.maxAgeMs ?? 2 * 60 * 60 * 1_000,
    completeness: "COMPLETE",
    languages: ["typescript"],
    expectedIndexer: {
      name: "scip-typescript",
      version: options.expectedIndexerVersion ?? "0.4.0",
    },
    documents: options.documents ?? [
      { uri: baseUri, sha256: baseDigest },
      { uri: implementationUri, sha256: implementationDigest },
    ],
  };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const adapter = new ScipRepositoryIntelligenceAdapter({
    manifest,
    indexPath: artifactPath,
    ...(options.bounds ? { bounds: options.bounds } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.now ? { now: options.now } : { now: () => new Date(fixedNow) }),
    ...(options.readArtifact ? { readArtifact: options.readArtifact } : {}),
  });
  return {
    root,
    repositoryPath,
    artifactPath,
    manifestPath,
    manifest,
    adapter,
    baseDigest,
    implementationDigest,
  };
};

const anchorFor = (
  value: Pick<Fixture, "baseDigest">,
  overrides: Partial<RepositoryIntelligenceSymbolAnchor> = {},
): RepositoryIntelligenceSymbolAnchor => ({
  uri: baseUri,
  name: "run",
  line: 2,
  documentDigest: value.baseDigest,
  ...overrides,
});

const queryFor = (
  value: Pick<Fixture, "repositoryPath" | "baseDigest">,
  operation: RepositoryIntelligenceOperation,
  overrides: Partial<RepositoryIntelligenceQuery> = {},
): RepositoryIntelligenceQuery => ({
  operation,
  repositoryPath: value.repositoryPath,
  projectId: "project-1",
  revision: "revision-1",
  maxResults: 20,
  ...(operation === "FIND_SYMBOL" ? { query: "run" } : { anchor: anchorFor(value) }),
  ...overrides,
});

describe("read-only SCIP v0.9 repository-intelligence adapter", () => {
  it("loads the MAF-owned manifest and publishes only the certified locator binding", async () => {
    const value = await fixture();
    const loaded = await loadScipRepositoryIntelligenceManifest(resolve(value.manifestPath));

    expect(loaded.indexPath).toBe(resolve(value.artifactPath));
    expect(loaded.manifest).toEqual(value.manifest);
    expect(value.adapter.bindingFor({ projectId: "project-1", revision: "revision-1" })).toEqual({
      projectId: "project-1",
      revision: "revision-1",
      sourceId: SCIP_SOURCE_ID,
      sourceDigest: value.manifest.indexSha256,
      sourceVersion: SCIP_SOURCE_VERSION,
      indexedAt,
      completeness: "COMPLETE",
      languages: ["typescript"],
    });
    expect(value.adapter.bindingFor({ projectId: "other", revision: "revision-1" })).toBeNull();
    expect(SCIP_REPOSITORY_INTELLIGENCE_CERTIFICATION).toMatchObject({
      upstream: "SCIP/scip-code",
      version: "v0.9.0",
      license: "Apache-2.0",
      indexerCertification: "SEPARATE_CERTIFICATION_REQUIRED",
      artifactAccess: "READ_ONLY",
      networkAccess: "NONE",
    });

    expect(() => parseScipRepositoryIntelligenceManifest("{")).toThrow("not valid JSON");
    expect(
      parseScipRepositoryIntelligenceManifest(
        JSON.stringify({
          ...value.manifest,
          languages: [" TypeScript ", "PYTHON", "typescript"],
        }),
      ).languages,
    ).toEqual(["python", "typescript"]);
  });

  it("physically contains a manifest-relative index across ancestor links", async () => {
    const value = await fixture();
    const trustedDirectory = dirname(value.manifestPath);
    const nestedDirectory = join(trustedDirectory, "nested");
    const bytes = indexWithDocuments(canonicalDocuments());
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(join(nestedDirectory, "index.scip"), bytes);
    const nestedManifest: ScipRepositoryIntelligenceManifest = {
      ...value.manifest,
      indexPath: "nested/index.scip",
      indexSha256: digest(bytes),
    };
    await writeFile(value.manifestPath, JSON.stringify(nestedManifest), "utf8");
    await expect(loadScipRepositoryIntelligenceManifest(value.manifestPath)).resolves.toMatchObject(
      {
        indexPath: resolve(nestedDirectory, "index.scip"),
      },
    );

    const outsideDirectory = join(value.root, "outside");
    const linkedDirectory = join(trustedDirectory, "linked");
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, "index.scip"), bytes);
    await symlink(
      outsideDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const escapingManifest: ScipRepositoryIntelligenceManifest = {
      ...value.manifest,
      indexPath: "linked/index.scip",
      indexSha256: digest(bytes),
    };
    await writeFile(value.manifestPath, JSON.stringify(escapingManifest), "utf8");

    await expect(loadScipRepositoryIntelligenceManifest(value.manifestPath)).rejects.toThrow(
      "physically escapes",
    );
    const directAdapter = new ScipRepositoryIntelligenceAdapter({
      manifest: escapingManifest,
      indexPath: join(linkedDirectory, "index.scip"),
      now: () => new Date(fixedNow),
    });
    await expect(directAdapter.query(queryFor(value, "FIND_SYMBOL"))).resolves.toMatchObject({
      status: "UNAVAILABLE",
      locations: [],
      reason: expect.stringContaining("physically escapes"),
    });
  });

  it("physically contains manifest-bound source documents across ancestor links", async () => {
    const value = await fixture();
    const outsideSourceDirectory = join(value.root, "outside-source");
    await mkdir(outsideSourceDirectory, { recursive: true });
    await writeFile(join(outsideSourceDirectory, "base.ts"), baseContent, "utf8");
    await writeFile(
      join(outsideSourceDirectory, "implementation.ts"),
      implementationContent,
      "utf8",
    );
    await rm(join(value.repositoryPath, "src"), { recursive: true });
    await symlink(
      outsideSourceDirectory,
      join(value.repositoryPath, "src"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(value.adapter.query(queryFor(value, "FIND_SYMBOL"))).resolves.toMatchObject({
      status: "STALE",
      locations: [],
      reason: expect.stringContaining("escapes the repository"),
    });
  });

  it("answers symbol, definition, reference, and implementation navigation deterministically", async () => {
    const value = await fixture();

    const symbols = await value.adapter.query(queryFor(value, "FIND_SYMBOL"));
    expect(symbols).toMatchObject({
      status: "COMPLETED",
      truncated: false,
      completeness: "COMPLETE",
    });
    expect(symbols.locations).toEqual([
      {
        uri: baseUri,
        name: "run",
        language: "typescript",
        role: "DEFINITION",
        range: {
          startLine: 2,
          startCharacter: 2,
          endLine: 2,
          endCharacter: 5,
          encoding: "UTF16_CODE_UNIT",
        },
        documentDigest: value.baseDigest,
      },
      {
        uri: implementationUri,
        name: "run",
        language: "typescript",
        role: "DEFINITION",
        range: {
          startLine: 2,
          startCharacter: 2,
          endLine: 2,
          endCharacter: 5,
          encoding: "UTF16_CODE_UNIT",
        },
        documentDigest: value.implementationDigest,
      },
    ]);

    const definitions = await value.adapter.query(queryFor(value, "FIND_DEFINITION"));
    expect(definitions.locations).toHaveLength(1);
    expect(definitions.locations[0]).toMatchObject({
      uri: baseUri,
      role: "DEFINITION",
      name: "run",
      range: { startLine: 2, startCharacter: 2 },
    });

    const references = await value.adapter.query(queryFor(value, "FIND_REFERENCES"));
    expect(references.locations).toEqual([
      expect.objectContaining({
        uri: baseUri,
        role: "REFERENCE",
        name: "run",
        range: expect.objectContaining({ startLine: 6, startCharacter: 9 }),
      }),
      expect.objectContaining({
        uri: implementationUri,
        role: "REFERENCE",
        name: "run",
        range: expect.objectContaining({ startLine: 6, startCharacter: 15 }),
      }),
    ]);

    const implementations = await value.adapter.query(queryFor(value, "FIND_IMPLEMENTATIONS"));
    expect(implementations.locations).toEqual([
      expect.objectContaining({
        uri: implementationUri,
        role: "IMPLEMENTATION",
        name: "run",
        range: expect.objectContaining({ startLine: 2, startCharacter: 2 }),
      }),
    ]);

    const serialized = JSON.stringify([
      symbols.locations,
      definitions.locations,
      references.locations,
      implementations.locations,
    ]);
    expect(serialized).not.toContain(baseSymbol);
    expect(serialized).not.toContain(implementationSymbol);
  });

  it("follows an explicit is_definition relationship without exposing its SCIP symbol ID", async () => {
    const relatedDefinitionDocument = document({
      uri: baseUri,
      occurrences: [
        occurrence({
          symbol: baseSymbol,
          typedSingleRange: [1, 2, 5],
        }),
        occurrence({
          symbol: canonicalDefinitionSymbol,
          roles: 1,
          typedSingleRange: [2, 2, 5],
        }),
      ],
      symbols: [
        symbolInformation(baseSymbol, "run", [
          { symbol: canonicalDefinitionSymbol, definition: true },
        ]),
        symbolInformation(canonicalDefinitionSymbol, "canonicalRun"),
      ],
    });
    const indexBytes = indexWithDocuments([relatedDefinitionDocument]);
    const value = await fixture({
      indexBytes,
      documents: [{ uri: baseUri, sha256: digest(baseContent) }],
    });

    const result = await value.adapter.query(queryFor(value, "FIND_DEFINITION"));

    expect(result.locations).toEqual([
      expect.objectContaining({
        uri: baseUri,
        name: "canonicalRun",
        role: "DEFINITION",
        range: expect.objectContaining({ startLine: 3, startCharacter: 2 }),
      }),
    ]);
    expect(JSON.stringify(result.locations)).not.toContain(canonicalDefinitionSymbol);
  });

  it("rejects a wrong revision before reading the artifact", async () => {
    const value = await fixture();
    const result = await value.adapter.query(
      queryFor(value, "FIND_SYMBOL", { revision: "revision-2" }),
    );
    expect(result).toMatchObject({
      status: "STALE",
      locations: [],
      reason: expect.stringContaining("project/revision"),
    });
  });

  it("detects stale index, document, anchor, and age bindings", async () => {
    const staleIndex = await fixture();
    await writeFile(staleIndex.artifactPath, Buffer.from([0x0a, 0x00]));
    await expect(
      staleIndex.adapter.query(queryFor(staleIndex, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "STALE",
      locations: [],
      reason: expect.stringContaining("SHA-256"),
    });

    const staleDocument = await fixture();
    await writeFile(
      join(staleDocument.repositoryPath, ...baseUri.split("/")),
      `${baseContent}// changed\n`,
      "utf8",
    );
    await expect(
      staleDocument.adapter.query(queryFor(staleDocument, "FIND_DEFINITION")),
    ).resolves.toMatchObject({
      status: "STALE",
      locations: [],
      reason: expect.stringContaining("source document SHA-256"),
    });

    const staleAnchor = await fixture();
    await expect(
      staleAnchor.adapter.query(
        queryFor(staleAnchor, "FIND_REFERENCES", {
          anchor: anchorFor(staleAnchor, { documentDigest: "0".repeat(64) }),
        }),
      ),
    ).resolves.toMatchObject({
      status: "STALE",
      locations: [],
      reason: expect.stringContaining("anchor document digest"),
    });

    const staleAge = await fixture({
      maxAgeMs: 1_000,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    await expect(staleAge.adapter.query(queryFor(staleAge, "FIND_SYMBOL"))).resolves.toMatchObject({
      status: "STALE",
      locations: [],
      reason: expect.stringContaining("age window"),
    });
  });

  it("reports unavailable artifacts and unsupported languages explicitly", async () => {
    const unavailable = await fixture();
    await rm(unavailable.artifactPath);
    await expect(
      unavailable.adapter.query(queryFor(unavailable, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "UNAVAILABLE",
      locations: [],
    });

    const unsupported = await fixture();
    await expect(
      unsupported.adapter.query(queryFor(unsupported, "FIND_SYMBOL", { language: "Python" })),
    ).resolves.toMatchObject({
      status: "UNSUPPORTED",
      locations: [],
    });

    await expect(
      unsupported.adapter.query(
        queryFor(unsupported, "FIND_SYMBOL", {
          repositoryPath: "\\\\server\\share",
        }),
      ),
    ).resolves.toMatchObject({ status: "MALFORMED", locations: [] });
  });

  it("enforces byte, document, occurrence, semantic, and result bounds with honest truncation", async () => {
    const resultBound = await fixture({ bounds: { maxResults: 1 } });
    await expect(
      resultBound.adapter.query(queryFor(resultBound, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "PARTIAL",
      truncated: true,
      completeness: "COMPLETE",
      locations: [{ uri: baseUri }],
    });

    const documentBound = await fixture({ bounds: { maxDocuments: 1 } });
    await expect(
      documentBound.adapter.query(queryFor(documentBound, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "PARTIAL",
      truncated: true,
      completeness: "PARTIAL",
      locations: [{ uri: baseUri }],
    });

    const occurrenceBound = await fixture({ bounds: { maxOccurrences: 1 } });
    await expect(
      occurrenceBound.adapter.query(queryFor(occurrenceBound, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "PARTIAL",
      truncated: true,
      completeness: "PARTIAL",
      locations: [{ uri: baseUri }],
    });

    const semanticBound = await fixture({ bounds: { maxSemanticEntries: 1 } });
    await expect(
      semanticBound.adapter.query(queryFor(semanticBound, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "PARTIAL",
      truncated: true,
      completeness: "PARTIAL",
      locations: [{ uri: baseUri }],
    });

    const relationshipBound = await fixture({ bounds: { maxSemanticEntries: 2 } });
    await expect(
      relationshipBound.adapter.query(queryFor(relationshipBound, "FIND_IMPLEMENTATIONS")),
    ).resolves.toMatchObject({
      status: "PARTIAL",
      truncated: true,
      completeness: "PARTIAL",
      locations: [],
    });

    const bytesValue = indexWithDocuments(canonicalDocuments());
    const byteBound = await fixture({
      indexBytes: bytesValue,
      bounds: { maxIndexBytes: bytesValue.byteLength - 1 },
    });
    await expect(
      byteBound.adapter.query(queryFor(byteBound, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "PARTIAL",
      truncated: true,
      completeness: "PARTIAL",
      locations: [],
    });

    const sourceDocumentBound = await fixture({
      bounds: { maxDocumentBytes: Buffer.byteLength(baseContent, "utf8") - 1 },
    });
    await expect(
      sourceDocumentBound.adapter.query(queryFor(sourceDocumentBound, "FIND_DEFINITION")),
    ).resolves.toMatchObject({
      status: "PARTIAL",
      truncated: true,
      completeness: "PARTIAL",
      locations: [],
    });
  });

  it("retains the same deterministic top result when artifact document order is reversed", async () => {
    const forward = await fixture({ bounds: { maxResults: 1 } });
    const reversedDocuments = canonicalDocuments().reverse();
    const reversed = await fixture({
      indexBytes: indexWithDocuments(reversedDocuments),
      bounds: { maxResults: 1 },
    });

    const [forwardResult, reversedResult] = await Promise.all([
      forward.adapter.query(queryFor(forward, "FIND_SYMBOL")),
      reversed.adapter.query(queryFor(reversed, "FIND_SYMBOL")),
    ]);
    expect(forwardResult).toMatchObject({
      status: "PARTIAL",
      truncated: true,
      locations: [{ uri: baseUri }],
    });
    expect(reversedResult).toMatchObject({
      status: "PARTIAL",
      truncated: true,
      locations: [{ uri: baseUri }],
    });
    expect(reversedResult.locations).toEqual(forwardResult.locations);
  });

  it("removes duplicate references without inventing transitive graph edges", async () => {
    const value = await fixture();
    const result = await value.adapter.query(queryFor(value, "FIND_REFERENCES"));

    expect(result.status).toBe("COMPLETED");
    expect(result.locations).toHaveLength(2);
    expect(new Set(result.locations.map((location) => location.uri))).toEqual(
      new Set([baseUri, implementationUri]),
    );
  });

  it("rejects malformed wire data, invalid ranges, and path escapes", async () => {
    const malformedWireBytes = concat(
      indexWithDocuments(canonicalDocuments()),
      Buffer.from([0x80]),
    );
    const malformedWire = await fixture({ indexBytes: malformedWireBytes });
    await expect(
      malformedWire.adapter.query(queryFor(malformedWire, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "MALFORMED",
      locations: [],
    });

    const invalidRangeDocument = document({
      uri: baseUri,
      occurrences: [occurrence({ symbol: baseSymbol, roles: 1, legacyRange: [1, 2] })],
      symbols: [symbolInformation(baseSymbol, "run")],
    });
    const invalidRangeBytes = indexWithDocuments([invalidRangeDocument]);
    const invalidRange = await fixture({
      indexBytes: invalidRangeBytes,
      documents: [{ uri: baseUri, sha256: digest(baseContent) }],
    });
    await expect(
      invalidRange.adapter.query(queryFor(invalidRange, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "MALFORMED",
      locations: [],
      reason: expect.stringContaining("exactly three or four"),
    });

    const escapingDocument = document({
      uri: "../escape.ts",
      occurrences: [
        occurrence({
          symbol: baseSymbol,
          roles: 1,
          typedSingleRange: [1, 2, 5],
        }),
      ],
      symbols: [symbolInformation(baseSymbol, "run")],
    });
    const escapingBytes = indexWithDocuments([escapingDocument]);
    const pathEscape = await fixture({
      indexBytes: escapingBytes,
      documents: [{ uri: baseUri, sha256: digest(baseContent) }],
    });
    await expect(
      pathEscape.adapter.query(queryFor(pathEscape, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "MALFORMED",
      locations: [],
      reason: expect.stringContaining("not canonical"),
    });
  });

  it("maps both caller abort and adapter deadline expiry to explicit TIMEOUT", async () => {
    const aborted = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.adapter.query(queryFor(aborted, "FIND_SYMBOL", { signal: controller.signal })),
    ).resolves.toMatchObject({
      status: "TIMEOUT",
      locations: [],
      reason: expect.stringContaining("aborted"),
    });

    const timedOut = await fixture({
      timeoutMs: 5,
      readArtifact: async (_handle, signal) =>
        await new Promise<Uint8Array>((_fulfill, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("fixture artifact read aborted")),
            { once: true },
          );
        }),
    });
    await expect(timedOut.adapter.query(queryFor(timedOut, "FIND_SYMBOL"))).resolves.toMatchObject({
      status: "TIMEOUT",
      locations: [],
      reason: expect.stringContaining("timeout"),
    });
  });

  it("checks the deadline again when post-decode semantic selection begins", async () => {
    const clock = vi.spyOn(performance, "now").mockImplementation(() => {
      const stack = new Error().stack ?? "";
      return stack.includes("selectLocations") ? 20_000 : 0;
    });
    try {
      const value = await fixture({ timeoutMs: 10_000 });
      await expect(value.adapter.query(queryFor(value, "FIND_SYMBOL"))).resolves.toMatchObject({
        status: "TIMEOUT",
        locations: [],
        reason: expect.stringContaining("timeout"),
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("checks the deadline immediately after synchronous artifact hashing", async () => {
    const clock = vi.spyOn(performance, "now").mockImplementation(() => {
      const stack = new Error().stack ?? "";
      return stack.includes("guardedSha256") ? 20_000 : 0;
    });
    try {
      const value = await fixture({
        timeoutMs: 10_000,
        indexSha256: "0".repeat(64),
      });
      await expect(value.adapter.query(queryFor(value, "FIND_SYMBOL"))).resolves.toMatchObject({
        status: "TIMEOUT",
        locations: [],
        reason: expect.stringContaining("timeout"),
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects source, protocol, and indexer version drift", async () => {
    const sourceVersion = await fixture({ sourceVersion: "v0.8.0" });
    await expect(
      sourceVersion.adapter.query(queryFor(sourceVersion, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "VERSION_MISMATCH",
      locations: [],
    });

    const protocolBytes = indexWithDocuments(canonicalDocuments(), "0.4.0", 1);
    const protocolVersion = await fixture({ indexBytes: protocolBytes });
    await expect(
      protocolVersion.adapter.query(queryFor(protocolVersion, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "VERSION_MISMATCH",
      locations: [],
      reason: expect.stringContaining("protocol"),
    });

    const indexerBytes = indexWithDocuments(canonicalDocuments(), "0.5.0");
    const indexerVersion = await fixture({ indexBytes: indexerBytes });
    await expect(
      indexerVersion.adapter.query(queryFor(indexerVersion, "FIND_SYMBOL")),
    ).resolves.toMatchObject({
      status: "VERSION_MISMATCH",
      locations: [],
      reason: expect.stringContaining("indexer"),
    });
  });
});
