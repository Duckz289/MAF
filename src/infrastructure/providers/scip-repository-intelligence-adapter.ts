import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  RepositoryIntelligenceCompleteness,
  RepositoryIntelligenceLocation,
  RepositoryIntelligenceProvider,
  RepositoryIntelligenceQuery,
  RepositoryIntelligenceResult,
  RepositoryIntelligenceSourceBinding,
} from "../../domain/repository-intelligence";

export const SCIP_SOURCE_ID = "scip-code/scip";
export const SCIP_SOURCE_VERSION = "v0.9.0";

export const SCIP_REPOSITORY_INTELLIGENCE_CERTIFICATION = Object.freeze({
  upstream: "SCIP/scip-code",
  version: SCIP_SOURCE_VERSION,
  license: "Apache-2.0",
  canonicalRepository: "https://github.com/scip-code/scip",
  indexerCertification: "SEPARATE_CERTIFICATION_REQUIRED",
  artifactAcquisition: "OPERATOR_GENERATED",
  artifactAccess: "READ_ONLY",
  networkAccess: "NONE",
} as const);

const manifestVersion = 1;
const maxManifestBytes = 4 * 1024 * 1024;
const maxManifestDocuments = 100_000;
const defaultBounds: ScipRepositoryIntelligenceBounds = {
  maxIndexBytes: 256 * 1024 * 1024,
  maxDocumentBytes: 16 * 1024 * 1024,
  maxDocuments: 100_000,
  maxOccurrences: 2_000_000,
  maxSemanticEntries: 2_000_000,
  maxResults: 1_000,
};
const defaultTimeoutMs = 15_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ScipRepositoryIntelligenceManifestDocument {
  readonly uri: string;
  readonly sha256: string;
}

/**
 * MAF-owned binding for an operator-produced artifact. The protocol producer remains separately
 * installed; its asserted identity is checked at query time, while certification remains an
 * external operator responsibility. This manifest never authorizes installation, execution, or
 * upload.
 */
export interface ScipRepositoryIntelligenceManifest {
  readonly manifestVersion: 1;
  readonly projectId: string;
  readonly revision: string;
  readonly indexPath: string;
  readonly indexSha256: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly indexedAt: string;
  readonly maxAgeMs: number;
  readonly completeness: RepositoryIntelligenceCompleteness;
  readonly languages: readonly string[];
  readonly expectedIndexer: {
    readonly name: string;
    readonly version: string;
  };
  readonly documents: readonly ScipRepositoryIntelligenceManifestDocument[];
}

export interface LoadedScipRepositoryIntelligenceManifest {
  readonly manifestPath: string;
  readonly indexPath: string;
  readonly manifest: ScipRepositoryIntelligenceManifest;
}

export interface ScipRepositoryIntelligenceBounds {
  readonly maxIndexBytes: number;
  readonly maxDocumentBytes: number;
  readonly maxDocuments: number;
  readonly maxOccurrences: number;
  /** Shared retained ceiling across SymbolInformation and Relationship entries. */
  readonly maxSemanticEntries: number;
  readonly maxResults: number;
}

export interface ScipRepositoryIntelligenceAdapterConfig {
  readonly manifest: ScipRepositoryIntelligenceManifest;
  /** Absolute path resolved from the trusted manifest by the root composition layer. */
  readonly indexPath: string;
  readonly bounds?: Partial<ScipRepositoryIntelligenceBounds>;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Test seam; production consumes the already verified, read-only file handle directly. */
  readonly readArtifact?: (handle: FileHandle, signal: AbortSignal) => Promise<Uint8Array>;
}

type RepositoryIntelligenceFailureStatus = Exclude<
  RepositoryIntelligenceResult["status"],
  "COMPLETED"
>;

interface SourceRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

interface RawRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isDefinition: boolean;
}

interface RawSymbolInformation {
  symbol: string;
  displayName: string;
  relationships: RawRelationship[];
}

interface RawOccurrence {
  range: SourceRange | null;
  symbol: string;
  symbolRoles: number;
}

interface RawDocument {
  uri: string;
  language: string;
  positionEncoding: number;
  occurrences: RawOccurrence[];
  symbols: RawSymbolInformation[];
}

interface ParsedMetadata {
  protocolVersion: number;
  indexerName: string;
  indexerVersion: string;
}

interface ParsedScipIndex {
  metadata: ParsedMetadata;
  documents: RawDocument[];
  externalSymbols: RawSymbolInformation[];
  documentsTruncated: boolean;
  occurrencesTruncated: boolean;
  semanticEntriesTruncated: boolean;
}

interface IndexedOccurrence {
  symbolKey: string;
  document: RawDocument;
  range: SourceRange;
  definition: boolean;
}

interface IndexedRelationship {
  source: string;
  target: string;
  isReference: boolean;
  isImplementation: boolean;
  isDefinition: boolean;
}

interface SemanticModel {
  documents: Map<string, RawDocument>;
  names: Map<string, string>;
  occurrences: IndexedOccurrence[];
  relationships: IndexedRelationship[];
  truncated: boolean;
}

class MalformedScipError extends Error {}
class ScipVersionMismatchError extends Error {}
class ScipArtifactContainmentError extends Error {}

class QueryInterruptedError extends Error {
  constructor(readonly cause: "ABORTED" | "TIMEOUT") {
    super(cause === "ABORTED" ? "The query was aborted." : "The query timed out.");
  }
}

class QueryGuard {
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly deadlineAt: number;
  private readonly timeoutHandle: ReturnType<typeof setTimeout>;
  private readonly parentSignal: AbortSignal | undefined;
  private interruption: "ABORTED" | "TIMEOUT" | null = null;

  private readonly onParentAbort = (): void => {
    this.interrupt("ABORTED");
  };

  constructor(timeoutMs: number, parentSignal?: AbortSignal) {
    this.signal = this.controller.signal;
    this.deadlineAt = performance.now() + timeoutMs;
    this.parentSignal = parentSignal;
    if (parentSignal?.aborted) this.interrupt("ABORTED");
    else parentSignal?.addEventListener("abort", this.onParentAbort, { once: true });
    this.timeoutHandle = setTimeout(() => {
      this.interrupt("TIMEOUT");
    }, timeoutMs);
  }

  check(): void {
    if (!this.interruption && performance.now() >= this.deadlineAt) {
      this.interrupt("TIMEOUT");
    }
    if (this.interruption) throw new QueryInterruptedError(this.interruption);
  }

  async wait<T>(promise: Promise<T>): Promise<T> {
    return await new Promise<T>((fulfill, reject) => {
      const onAbort = (): void => {
        reject(new QueryInterruptedError(this.interruption ?? "TIMEOUT"));
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          this.signal.removeEventListener("abort", onAbort);
          fulfill(value);
        },
        (error: unknown) => {
          this.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
      // Attach both promise handlers before checking the deadline. A deadline may have elapsed
      // after the caller created an abort-aware promise; checking first would leave that promise's
      // abort rejection unobserved.
      try {
        this.check();
      } catch (error) {
        this.signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    });
  }

  dispose(): void {
    clearTimeout(this.timeoutHandle);
    this.parentSignal?.removeEventListener("abort", this.onParentAbort);
  }

  private interrupt(cause: "ABORTED" | "TIMEOUT"): void {
    if (this.interruption) return;
    this.interruption = cause;
    this.controller.abort(cause);
  }
}

const checkGuardPeriodically = (guard: QueryGuard, work: number): void => {
  if ((work & 1_023) === 0) guard.check();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const nonEmptyBoundedText = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");

const looksRemote = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || /^git\+/iu.test(value);

const looksLikeUncPath = (value: string): boolean =>
  value.startsWith("\\\\") || value.startsWith("//");

const isCanonicalRelativePath = (value: unknown): value is string => {
  if (
    !nonEmptyBoundedText(value, 4_096) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    looksRemote(value) ||
    looksLikeUncPath(value)
  ) {
    return false;
  }
  const components = value.split("/");
  return components.every(
    (component) => component.length > 0 && component !== "." && component !== "..",
  );
};

const assertAbsoluteLocalPath = (label: string, value: string): void => {
  if (
    !nonEmptyBoundedText(value, 32_768) ||
    !isAbsolute(value) ||
    looksRemote(value) ||
    looksLikeUncPath(value)
  ) {
    throw new Error(`${label} must be an absolute local filesystem path`);
  }
};

const assertPositiveInteger = (label: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
};

const isWithin = (root: string, candidate: string): boolean => {
  const relationship = relative(root, candidate);
  return (
    relationship === "" ||
    (relationship !== ".." && !relationship.startsWith(`..${sep}`) && !isAbsolute(relationship))
  );
};

const cloneAndValidateManifest = (input: unknown): ScipRepositoryIntelligenceManifest => {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "manifestVersion",
      "projectId",
      "revision",
      "indexPath",
      "indexSha256",
      "sourceId",
      "sourceVersion",
      "indexedAt",
      "maxAgeMs",
      "completeness",
      "languages",
      "expectedIndexer",
      "documents",
    ])
  ) {
    throw new Error("SCIP manifest must contain exactly the supported version-1 fields");
  }
  if (input.manifestVersion !== manifestVersion) {
    throw new Error("SCIP manifestVersion must be exactly 1");
  }
  if (!nonEmptyBoundedText(input.projectId) || !nonEmptyBoundedText(input.revision)) {
    throw new Error("SCIP manifest projectId and revision must be non-empty bounded strings");
  }
  if (!isCanonicalRelativePath(input.indexPath)) {
    throw new Error("SCIP manifest indexPath must be a canonical relative path");
  }
  if (typeof input.indexSha256 !== "string" || !sha256Pattern.test(input.indexSha256)) {
    throw new Error("SCIP manifest indexSha256 must be a lowercase SHA-256 digest");
  }
  if (
    !nonEmptyBoundedText(input.sourceId) ||
    !nonEmptyBoundedText(input.sourceVersion, 128) ||
    !nonEmptyBoundedText(input.indexedAt)
  ) {
    throw new Error("SCIP manifest source identity and indexedAt must be bounded strings");
  }
  const indexedAtMs = Date.parse(input.indexedAt);
  if (!Number.isFinite(indexedAtMs) || new Date(indexedAtMs).toISOString() !== input.indexedAt) {
    throw new Error("SCIP manifest indexedAt must be a canonical ISO-8601 instant");
  }
  if (
    typeof input.maxAgeMs !== "number" ||
    !Number.isSafeInteger(input.maxAgeMs) ||
    input.maxAgeMs <= 0
  ) {
    throw new Error("SCIP manifest maxAgeMs must be a positive safe integer");
  }
  if (
    input.completeness !== "COMPLETE" &&
    input.completeness !== "PARTIAL" &&
    input.completeness !== "UNKNOWN"
  ) {
    throw new Error("SCIP manifest completeness is invalid");
  }
  if (
    !Array.isArray(input.languages) ||
    input.languages.length === 0 ||
    input.languages.length > 64 ||
    input.languages.some(
      (language) => !nonEmptyBoundedText(language, 64) || language.trim().length === 0,
    )
  ) {
    throw new Error("SCIP manifest languages must be a non-empty bounded string array");
  }
  const languages = [
    ...new Set(
      (input.languages as string[]).map((language) => language.trim().toLocaleLowerCase("en-US")),
    ),
  ].sort();
  if (
    !isRecord(input.expectedIndexer) ||
    !hasExactKeys(input.expectedIndexer, ["name", "version"]) ||
    !nonEmptyBoundedText(input.expectedIndexer.name) ||
    !nonEmptyBoundedText(input.expectedIndexer.version)
  ) {
    throw new Error("SCIP manifest expectedIndexer must bind an exact name and version");
  }
  if (!Array.isArray(input.documents) || input.documents.length > maxManifestDocuments) {
    throw new Error("SCIP manifest documents exceed the manifest safety bound");
  }
  const documents = input.documents.map((document) => {
    if (
      !isRecord(document) ||
      !hasExactKeys(document, ["uri", "sha256"]) ||
      !isCanonicalRelativePath(document.uri) ||
      typeof document.sha256 !== "string" ||
      !sha256Pattern.test(document.sha256)
    ) {
      throw new Error("SCIP manifest document bindings must contain canonical uri/SHA-256 pairs");
    }
    return Object.freeze({ uri: document.uri, sha256: document.sha256 });
  });
  documents.sort((left, right) => left.uri.localeCompare(right.uri, "en"));
  if (new Set(documents.map((document) => document.uri)).size !== documents.length) {
    throw new Error("SCIP manifest document URIs must be unique");
  }
  return Object.freeze({
    manifestVersion: 1,
    projectId: input.projectId,
    revision: input.revision,
    indexPath: input.indexPath,
    indexSha256: input.indexSha256,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    indexedAt: input.indexedAt,
    maxAgeMs: input.maxAgeMs,
    completeness: input.completeness,
    languages: Object.freeze(languages),
    expectedIndexer: Object.freeze({
      name: input.expectedIndexer.name,
      version: input.expectedIndexer.version,
    }),
    documents: Object.freeze(documents),
  });
};

export const parseScipRepositoryIntelligenceManifest = (
  json: string,
): ScipRepositoryIntelligenceManifest => {
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maxManifestBytes) {
    throw new Error("SCIP manifest JSON exceeds the bounded parser input");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("SCIP manifest is not valid JSON");
  }
  return cloneAndValidateManifest(parsed);
};

export const loadScipRepositoryIntelligenceManifest = async (
  manifestPathInput: string,
): Promise<LoadedScipRepositoryIntelligenceManifest> => {
  assertAbsoluteLocalPath("manifestPath", manifestPathInput);
  const manifestPath = resolve(manifestPathInput);
  const information = await lstat(manifestPath);
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > maxManifestBytes
  ) {
    throw new Error("SCIP manifest path must be a bounded regular file, not a symbolic link");
  }
  const manifest = parseScipRepositoryIntelligenceManifest(await readFile(manifestPath, "utf8"));
  const manifestDirectory = resolve(manifestPath, "..");
  const indexPath = resolve(manifestDirectory, ...manifest.indexPath.split("/"));
  if (!isWithin(manifestDirectory, indexPath)) {
    throw new Error("SCIP manifest indexPath escapes the manifest directory");
  }
  const [manifestDirectoryRealPath, indexRealPath, indexInformation] = await Promise.all([
    realpath(manifestDirectory),
    realpath(indexPath),
    lstat(indexPath),
  ]);
  if (!isWithin(manifestDirectoryRealPath, indexRealPath)) {
    throw new Error("SCIP manifest indexPath physically escapes the manifest directory");
  }
  if (!indexInformation.isFile() || indexInformation.isSymbolicLink()) {
    throw new Error("SCIP manifest indexPath must resolve to a regular non-symbolic-link file");
  }
  return Object.freeze({ manifestPath, indexPath, manifest });
};

class WireReader {
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly guard: QueryGuard,
  ) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  readTag(): { field: number; wire: number } {
    const key = this.readUnsigned();
    if (key > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MalformedScipError("A protobuf field key exceeds the safe integer range.");
    }
    const numeric = Number(key);
    const field = Math.floor(numeric / 8);
    const wire = numeric & 7;
    if (field <= 0) throw new MalformedScipError("A protobuf field number is invalid.");
    return { field, wire };
  }

  readUnsigned(): bigint {
    this.guard.check();
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.offset >= this.bytes.length) {
        throw new MalformedScipError("A protobuf varint is truncated.");
      }
      const byte = this.bytes[this.offset];
      this.offset += 1;
      if (byte === undefined) throw new MalformedScipError("A protobuf varint is truncated.");
      if (shift === 63n && byte > 1) {
        throw new MalformedScipError("A protobuf varint exceeds 64 bits.");
      }
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new MalformedScipError("A protobuf varint exceeds 64 bits.");
  }

  readSafeUnsigned(label: string): number {
    const value = this.readUnsigned();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MalformedScipError(`${label} exceeds the safe integer range.`);
    }
    return Number(value);
  }

  readBytes(): Uint8Array {
    const length = this.readSafeUnsigned("A protobuf byte field length");
    if (length > this.bytes.length - this.offset) {
      throw new MalformedScipError("A protobuf byte field is truncated.");
    }
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }

  readString(): string {
    try {
      return decoder.decode(this.readBytes());
    } catch (error) {
      if (error instanceof MalformedScipError) throw error;
      throw new MalformedScipError("A protobuf string is not valid UTF-8.");
    }
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.readUnsigned();
        return;
      case 1:
        this.skipBytes(8);
        return;
      case 2:
        this.readBytes();
        return;
      case 5:
        this.skipBytes(4);
        return;
      default:
        throw new MalformedScipError(`Unsupported protobuf wire type ${String(wire)}.`);
    }
  }

  private skipBytes(length: number): void {
    if (length > this.bytes.length - this.offset) {
      throw new MalformedScipError("A fixed-width protobuf field is truncated.");
    }
    this.offset += length;
  }
}

const requireWire = (actual: number, expected: number, label: string): void => {
  if (actual !== expected) {
    throw new MalformedScipError(`${label} uses an invalid protobuf wire type.`);
  }
};

const int32 = (reader: WireReader, label: string): number => {
  const value = reader.readUnsigned();
  if (value > 0x7fffffffn) {
    throw new MalformedScipError(`${label} must be a non-negative int32.`);
  }
  return Number(value);
};

const parseSingleLineRange = (bytes: Uint8Array, guard: QueryGuard): SourceRange => {
  const reader = new WireReader(bytes, guard);
  let line = 0;
  let startCharacter = 0;
  let endCharacter = 0;
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1) {
      requireWire(wire, 0, "SingleLineRange.line");
      line = int32(reader, "SingleLineRange.line");
    } else if (field === 2) {
      requireWire(wire, 0, "SingleLineRange.start_character");
      startCharacter = int32(reader, "SingleLineRange.start_character");
    } else if (field === 3) {
      requireWire(wire, 0, "SingleLineRange.end_character");
      endCharacter = int32(reader, "SingleLineRange.end_character");
    } else {
      reader.skip(wire);
    }
  }
  if (endCharacter < startCharacter) {
    throw new MalformedScipError("A single-line range ends before it starts.");
  }
  return { startLine: line, startCharacter, endLine: line, endCharacter };
};

const parseMultiLineRange = (bytes: Uint8Array, guard: QueryGuard): SourceRange => {
  const reader = new WireReader(bytes, guard);
  let startLine = 0;
  let startCharacter = 0;
  let endLine = 0;
  let endCharacter = 0;
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1) {
      requireWire(wire, 0, "MultiLineRange.start_line");
      startLine = int32(reader, "MultiLineRange.start_line");
    } else if (field === 2) {
      requireWire(wire, 0, "MultiLineRange.start_character");
      startCharacter = int32(reader, "MultiLineRange.start_character");
    } else if (field === 3) {
      requireWire(wire, 0, "MultiLineRange.end_line");
      endLine = int32(reader, "MultiLineRange.end_line");
    } else if (field === 4) {
      requireWire(wire, 0, "MultiLineRange.end_character");
      endCharacter = int32(reader, "MultiLineRange.end_character");
    } else {
      reader.skip(wire);
    }
  }
  if (endLine < startLine || (endLine === startLine && endCharacter < startCharacter)) {
    throw new MalformedScipError("A multi-line range ends before it starts.");
  }
  return { startLine, startCharacter, endLine, endCharacter };
};

const parseLegacyRange = (values: number[]): SourceRange => {
  if (values.length === 3) {
    const [startLine, startCharacter, endCharacter] = values;
    if (
      startLine === undefined ||
      startCharacter === undefined ||
      endCharacter === undefined ||
      endCharacter < startCharacter
    ) {
      throw new MalformedScipError("A legacy single-line range is invalid.");
    }
    return { startLine, startCharacter, endLine: startLine, endCharacter };
  }
  if (values.length === 4) {
    const [startLine, startCharacter, endLine, endCharacter] = values;
    if (
      startLine === undefined ||
      startCharacter === undefined ||
      endLine === undefined ||
      endCharacter === undefined ||
      endLine < startLine ||
      (endLine === startLine && endCharacter < startCharacter)
    ) {
      throw new MalformedScipError("A legacy multi-line range is invalid.");
    }
    return { startLine, startCharacter, endLine, endCharacter };
  }
  throw new MalformedScipError(
    "A legacy SCIP range must contain exactly three or four int32 values.",
  );
};

const parsePackedInt32 = (bytes: Uint8Array, guard: QueryGuard): number[] => {
  const reader = new WireReader(bytes, guard);
  const values: number[] = [];
  while (!reader.done) values.push(int32(reader, "Occurrence.range"));
  return values;
};

const parseOccurrence = (bytes: Uint8Array, guard: QueryGuard): RawOccurrence => {
  const reader = new WireReader(bytes, guard);
  const legacyRange: number[] = [];
  let typedRange: SourceRange | null = null;
  let hasTypedRange = false;
  let symbol = "";
  let symbolRoles = 0;
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1:
        if (wire === 0) legacyRange.push(int32(reader, "Occurrence.range"));
        else if (wire === 2) legacyRange.push(...parsePackedInt32(reader.readBytes(), guard));
        else throw new MalformedScipError("Occurrence.range uses an invalid protobuf wire type.");
        break;
      case 2:
        requireWire(wire, 2, "Occurrence.symbol");
        symbol = reader.readString();
        break;
      case 3:
        requireWire(wire, 0, "Occurrence.symbol_roles");
        symbolRoles = int32(reader, "Occurrence.symbol_roles");
        break;
      case 8:
        requireWire(wire, 2, "Occurrence.single_line_range");
        typedRange = parseSingleLineRange(reader.readBytes(), guard);
        hasTypedRange = true;
        break;
      case 9:
        requireWire(wire, 2, "Occurrence.multi_line_range");
        typedRange = parseMultiLineRange(reader.readBytes(), guard);
        hasTypedRange = true;
        break;
      default:
        reader.skip(wire);
    }
  }
  const range = hasTypedRange
    ? typedRange
    : legacyRange.length > 0
      ? parseLegacyRange(legacyRange)
      : null;
  if (symbol.length > 0 && !range) {
    throw new MalformedScipError("A symbol occurrence is missing its source range.");
  }
  return { range, symbol, symbolRoles };
};

const parseRelationship = (bytes: Uint8Array, guard: QueryGuard): RawRelationship => {
  const reader = new WireReader(bytes, guard);
  let symbol = "";
  let isReference = false;
  let isImplementation = false;
  let isDefinition = false;
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1) {
      requireWire(wire, 2, "Relationship.symbol");
      symbol = reader.readString();
    } else if (field === 2) {
      requireWire(wire, 0, "Relationship.is_reference");
      isReference = reader.readUnsigned() !== 0n;
    } else if (field === 3) {
      requireWire(wire, 0, "Relationship.is_implementation");
      isImplementation = reader.readUnsigned() !== 0n;
    } else if (field === 5) {
      requireWire(wire, 0, "Relationship.is_definition");
      isDefinition = reader.readUnsigned() !== 0n;
    } else {
      reader.skip(wire);
    }
  }
  if (symbol.length === 0) {
    throw new MalformedScipError("A SCIP relationship is missing its target symbol.");
  }
  return { symbol, isReference, isImplementation, isDefinition };
};

interface SemanticParseLimits {
  semanticEntries: number;
  semanticEntriesTruncated: boolean;
}

const reserveSemanticEntry = (limits: SemanticParseLimits, maximum: number): boolean => {
  limits.semanticEntries += 1;
  if (limits.semanticEntries <= maximum) return true;
  limits.semanticEntriesTruncated = true;
  return false;
};

const parseSymbolInformation = (
  bytes: Uint8Array,
  guard: QueryGuard,
  limits: SemanticParseLimits,
  maxSemanticEntries: number,
): RawSymbolInformation => {
  const reader = new WireReader(bytes, guard);
  let symbol = "";
  let displayName = "";
  const relationships: RawRelationship[] = [];
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1) {
      requireWire(wire, 2, "SymbolInformation.symbol");
      symbol = reader.readString();
    } else if (field === 4) {
      requireWire(wire, 2, "SymbolInformation.relationships");
      const relationshipBytes = reader.readBytes();
      if (reserveSemanticEntry(limits, maxSemanticEntries)) {
        relationships.push(parseRelationship(relationshipBytes, guard));
      }
    } else if (field === 6) {
      requireWire(wire, 2, "SymbolInformation.display_name");
      displayName = reader.readString();
    } else {
      reader.skip(wire);
    }
  }
  if (symbol.length === 0) {
    throw new MalformedScipError("A SCIP SymbolInformation entry is missing its symbol.");
  }
  return { symbol, displayName, relationships };
};

const parseToolInfo = (
  bytes: Uint8Array,
  guard: QueryGuard,
): {
  name: string;
  version: string;
} => {
  const reader = new WireReader(bytes, guard);
  let name = "";
  let version = "";
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1) {
      requireWire(wire, 2, "ToolInfo.name");
      name = reader.readString();
    } else if (field === 2) {
      requireWire(wire, 2, "ToolInfo.version");
      version = reader.readString();
    } else {
      reader.skip(wire);
    }
  }
  return { name, version };
};

const parseMetadata = (bytes: Uint8Array, guard: QueryGuard): ParsedMetadata => {
  const reader = new WireReader(bytes, guard);
  let protocolVersion = 0;
  let indexerName = "";
  let indexerVersion = "";
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1) {
      requireWire(wire, 0, "Metadata.version");
      protocolVersion = int32(reader, "Metadata.version");
    } else if (field === 2) {
      requireWire(wire, 2, "Metadata.tool_info");
      const tool = parseToolInfo(reader.readBytes(), guard);
      indexerName = tool.name;
      indexerVersion = tool.version;
    } else {
      reader.skip(wire);
    }
  }
  return { protocolVersion, indexerName, indexerVersion };
};

interface ParseLimits extends SemanticParseLimits {
  documents: number;
  occurrences: number;
  documentsTruncated: boolean;
  occurrencesTruncated: boolean;
}

const parseDocument = (
  bytes: Uint8Array,
  guard: QueryGuard,
  limits: ParseLimits,
  maxOccurrences: number,
  maxSemanticEntries: number,
): RawDocument => {
  const reader = new WireReader(bytes, guard);
  let uri = "";
  let language = "";
  let positionEncoding = 0;
  const occurrences: RawOccurrence[] = [];
  const symbols: RawSymbolInformation[] = [];
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1) {
      requireWire(wire, 2, "Document.relative_path");
      uri = reader.readString();
    } else if (field === 2) {
      requireWire(wire, 2, "Document.occurrences");
      limits.occurrences += 1;
      const occurrenceBytes = reader.readBytes();
      if (limits.occurrences <= maxOccurrences) {
        occurrences.push(parseOccurrence(occurrenceBytes, guard));
      } else {
        limits.occurrencesTruncated = true;
      }
    } else if (field === 3) {
      requireWire(wire, 2, "Document.symbols");
      const symbolBytes = reader.readBytes();
      if (reserveSemanticEntry(limits, maxSemanticEntries)) {
        symbols.push(parseSymbolInformation(symbolBytes, guard, limits, maxSemanticEntries));
      }
    } else if (field === 4) {
      requireWire(wire, 2, "Document.language");
      language = reader.readString();
    } else if (field === 6) {
      requireWire(wire, 0, "Document.position_encoding");
      positionEncoding = int32(reader, "Document.position_encoding");
    } else {
      reader.skip(wire);
    }
  }
  if (!isCanonicalRelativePath(uri)) {
    throw new MalformedScipError("A SCIP document path is not canonical and repository-relative.");
  }
  if (!nonEmptyBoundedText(language, 64) || language.trim().length === 0) {
    throw new MalformedScipError("A SCIP document is missing a bounded language identifier.");
  }
  if (positionEncoding < 0 || positionEncoding > 3) {
    throw new MalformedScipError("A SCIP document uses an unknown position encoding.");
  }
  return {
    uri,
    language: language.trim().toLocaleLowerCase("en-US"),
    positionEncoding,
    occurrences,
    symbols,
  };
};

const parseScipIndex = (
  bytes: Uint8Array,
  guard: QueryGuard,
  bounds: ScipRepositoryIntelligenceBounds,
): ParsedScipIndex => {
  const reader = new WireReader(bytes, guard);
  let metadata: ParsedMetadata | null = null;
  let firstField = true;
  const documents: RawDocument[] = [];
  const externalSymbols: RawSymbolInformation[] = [];
  const limits: ParseLimits = {
    documents: 0,
    occurrences: 0,
    semanticEntries: 0,
    documentsTruncated: false,
    occurrencesTruncated: false,
    semanticEntriesTruncated: false,
  };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (firstField && field !== 1) {
      throw new MalformedScipError("SCIP v0.9 metadata must be the first Index field.");
    }
    firstField = false;
    if (field === 1) {
      requireWire(wire, 2, "Index.metadata");
      if (metadata) throw new MalformedScipError("A SCIP index contains duplicate metadata.");
      metadata = parseMetadata(reader.readBytes(), guard);
    } else if (field === 2) {
      requireWire(wire, 2, "Index.documents");
      limits.documents += 1;
      const documentBytes = reader.readBytes();
      if (limits.documents <= bounds.maxDocuments) {
        documents.push(
          parseDocument(
            documentBytes,
            guard,
            limits,
            bounds.maxOccurrences,
            bounds.maxSemanticEntries,
          ),
        );
      } else {
        limits.documentsTruncated = true;
      }
    } else if (field === 3) {
      requireWire(wire, 2, "Index.external_symbols");
      const symbolBytes = reader.readBytes();
      if (reserveSemanticEntry(limits, bounds.maxSemanticEntries)) {
        externalSymbols.push(
          parseSymbolInformation(symbolBytes, guard, limits, bounds.maxSemanticEntries),
        );
      }
    } else {
      reader.skip(wire);
    }
  }
  if (!metadata) throw new MalformedScipError("A SCIP index is missing metadata.");
  return {
    metadata,
    documents,
    externalSymbols,
    documentsTruncated: limits.documentsTruncated,
    occurrencesTruncated: limits.occurrencesTruncated,
    semanticEntriesTruncated: limits.semanticEntriesTruncated,
  };
};

const localSymbol = (symbol: string): boolean => symbol.startsWith("local ");

const symbolKey = (symbol: string, uri: string | null): string => {
  if (!localSymbol(symbol)) return `global:${symbol}`;
  if (!uri)
    throw new MalformedScipError("An external symbol cannot use a document-local identity.");
  return `local:${uri}\0${symbol}`;
};

const buildSemanticModel = (
  parsed: ParsedScipIndex,
  manifest: ScipRepositoryIntelligenceManifest,
  guard: QueryGuard,
): SemanticModel => {
  let work = 0;
  const checkpoint = (): void => {
    checkGuardPeriodically(guard, work);
    work += 1;
  };
  guard.check();
  const documents = new Map<string, RawDocument>();
  const manifestDocuments = new Map<string, string>();
  for (const document of manifest.documents) {
    checkpoint();
    manifestDocuments.set(document.uri, document.sha256);
  }
  const supportedLanguages = new Set<string>();
  for (const language of manifest.languages) {
    checkpoint();
    supportedLanguages.add(language.toLocaleLowerCase("en-US"));
  }
  for (const document of parsed.documents) {
    checkpoint();
    if (documents.has(document.uri)) {
      throw new MalformedScipError("The SCIP index contains a duplicate document path.");
    }
    if (!manifestDocuments.has(document.uri)) {
      throw new MalformedScipError("A SCIP document has no manifest digest binding.");
    }
    if (!supportedLanguages.has(document.language.toLocaleLowerCase("en-US"))) {
      throw new MalformedScipError("A SCIP document language is not declared by the manifest.");
    }
    documents.set(document.uri, document);
  }
  let documentSetsMatch = documents.size === manifestDocuments.size;
  if (!parsed.documentsTruncated && documentSetsMatch) {
    for (const document of manifest.documents) {
      checkpoint();
      if (!documents.has(document.uri)) {
        documentSetsMatch = false;
        break;
      }
    }
  }
  if (!parsed.documentsTruncated && !documentSetsMatch) {
    throw new MalformedScipError("The SCIP index and manifest document sets do not match exactly.");
  }

  const names = new Map<string, string>();
  const relationships: IndexedRelationship[] = [];
  const register = (information: RawSymbolInformation, uri: string | null): void => {
    checkpoint();
    const source = symbolKey(information.symbol, uri);
    if (information.displayName.length > 0) {
      const prior = names.get(source);
      if (prior && prior !== information.displayName) {
        throw new MalformedScipError("Conflicting display names exist for one SCIP symbol.");
      }
      names.set(source, information.displayName);
    }
    for (const relationship of information.relationships) {
      checkpoint();
      relationships.push({
        source,
        target: symbolKey(relationship.symbol, uri),
        isReference: relationship.isReference,
        isImplementation: relationship.isImplementation,
        isDefinition: relationship.isDefinition,
      });
    }
  };
  for (const document of parsed.documents) {
    checkpoint();
    for (const information of document.symbols) register(information, document.uri);
  }
  for (const information of parsed.externalSymbols) {
    register(information, null);
  }

  const occurrences: IndexedOccurrence[] = [];
  for (const document of parsed.documents) {
    checkpoint();
    for (const occurrence of document.occurrences) {
      checkpoint();
      if (!occurrence.range || occurrence.symbol.length === 0) continue;
      occurrences.push({
        symbolKey: symbolKey(occurrence.symbol, document.uri),
        document,
        range: occurrence.range,
        definition: (occurrence.symbolRoles & 1) !== 0,
      });
    }
  }
  guard.check();
  return {
    documents,
    names,
    occurrences,
    relationships,
    truncated:
      parsed.documentsTruncated || parsed.occurrencesTruncated || parsed.semanticEntriesTruncated,
  };
};

const sourceBinding = (
  manifest: ScipRepositoryIntelligenceManifest,
): RepositoryIntelligenceSourceBinding => ({
  projectId: manifest.projectId,
  revision: manifest.revision,
  sourceId: manifest.sourceId,
  sourceDigest: manifest.indexSha256,
  sourceVersion: manifest.sourceVersion,
  indexedAt: manifest.indexedAt,
  completeness: manifest.completeness,
  languages: [...manifest.languages],
});

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const failure = (
  status: RepositoryIntelligenceFailureStatus,
  reason: string,
  source: RepositoryIntelligenceSourceBinding | null,
  truncated = false,
  completeness: RepositoryIntelligenceCompleteness = source?.completeness ?? "UNKNOWN",
): RepositoryIntelligenceResult => ({
  status,
  reason,
  source,
  locations: [],
  truncated,
  completeness,
});

const compareLocations = (
  left: RepositoryIntelligenceLocation,
  right: RepositoryIntelligenceLocation,
): number =>
  left.uri.localeCompare(right.uri, "en") ||
  left.range.startLine - right.range.startLine ||
  left.range.startCharacter - right.range.startCharacter ||
  left.range.endLine - right.range.endLine ||
  left.range.endCharacter - right.range.endCharacter ||
  left.role.localeCompare(right.role, "en") ||
  left.name.localeCompare(right.name, "en") ||
  left.language.localeCompare(right.language, "en") ||
  left.range.encoding.localeCompare(right.range.encoding, "en") ||
  left.documentDigest.localeCompare(right.documentDigest, "en");

const locationKey = (location: RepositoryIntelligenceLocation): string =>
  [
    location.uri,
    location.range.startLine,
    location.range.startCharacter,
    location.range.endLine,
    location.range.endCharacter,
    location.role,
    location.name,
    location.language,
    location.documentDigest,
  ].join("\0");

class BoundedLocationCollector {
  private readonly locationsByKey = new Map<string, RepositoryIntelligenceLocation>();
  /** Max-heap: the least preferred retained location is always at index zero. */
  private readonly heap: RepositoryIntelligenceLocation[] = [];
  private overflowed = false;

  constructor(
    private readonly capacity: number,
    private readonly guard: QueryGuard,
  ) {}

  add(location: RepositoryIntelligenceLocation): void {
    this.guard.check();
    const key = locationKey(location);
    if (this.locationsByKey.has(key)) return;
    if (this.heap.length < this.capacity) {
      this.locationsByKey.set(key, location);
      this.heap.push(location);
      this.siftUp(this.heap.length - 1);
      return;
    }

    this.overflowed = true;
    const worst = this.heap[0];
    if (!worst || compareLocations(location, worst) >= 0) return;
    this.locationsByKey.delete(locationKey(worst));
    this.locationsByKey.set(key, location);
    this.heap[0] = location;
    this.siftDown(0);
  }

  finish(): { locations: RepositoryIntelligenceLocation[]; truncated: boolean } {
    this.guard.check();
    return {
      locations: [...this.locationsByKey.values()].sort(compareLocations),
      truncated: this.overflowed,
    };
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.heap[parent];
      const value = this.heap[index];
      if (!parentValue || !value || compareLocations(parentValue, value) >= 0) return;
      this.heap[parent] = value;
      this.heap[index] = parentValue;
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.heap.length) return;
      const right = left + 1;
      const leftValue = this.heap[left];
      const rightValue = this.heap[right];
      let larger = left;
      if (leftValue && rightValue && compareLocations(rightValue, leftValue) > 0) larger = right;
      const value = this.heap[index];
      const largerValue = this.heap[larger];
      if (!value || !largerValue || compareLocations(value, largerValue) >= 0) return;
      this.heap[index] = largerValue;
      this.heap[larger] = value;
      index = larger;
    }
  }
}

const encodingFor = (value: number): RepositoryIntelligenceLocation["range"]["encoding"] => {
  if (value === 1) return "UTF8_CODE_UNIT";
  if (value === 2) return "UTF16_CODE_UNIT";
  if (value === 3) return "UTF32_CODE_UNIT";
  return "UNKNOWN";
};

const errno = (error: unknown, code: string): boolean => isRecord(error) && error.code === code;

const sameFileIdentity = (
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean => left.dev === right.dev && left.ino === right.ino;

const guardedSha256 = (bytes: Uint8Array, guard: QueryGuard): string => {
  const digest = createHash("sha256").update(bytes).digest("hex");
  guard.check();
  return digest;
};

export class ScipRepositoryIntelligenceAdapter implements RepositoryIntelligenceProvider {
  readonly name = "scip-read-only-artifact";

  private readonly manifest: ScipRepositoryIntelligenceManifest;
  private readonly documentDigests: ReadonlyMap<string, string>;
  private readonly indexPath: string;
  private readonly artifactRootPath: string;
  private readonly bounds: ScipRepositoryIntelligenceBounds;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly readArtifact:
    | ((handle: FileHandle, signal: AbortSignal) => Promise<Uint8Array>)
    | undefined;

  constructor(config: ScipRepositoryIntelligenceAdapterConfig) {
    this.manifest = cloneAndValidateManifest(config.manifest);
    this.documentDigests = new Map(
      this.manifest.documents.map((document) => [document.uri, document.sha256]),
    );
    assertAbsoluteLocalPath("indexPath", config.indexPath);
    this.indexPath = resolve(config.indexPath);
    this.artifactRootPath = this.manifest.indexPath
      .split("/")
      .reduce((candidate) => resolve(candidate, ".."), this.indexPath);
    const manifestResolvedIndexPath = resolve(
      this.artifactRootPath,
      ...this.manifest.indexPath.split("/"),
    );
    if (relative(manifestResolvedIndexPath, this.indexPath) !== "") {
      throw new Error("indexPath must be the exact absolute resolution of manifest.indexPath");
    }
    this.bounds = {
      maxIndexBytes: config.bounds?.maxIndexBytes ?? defaultBounds.maxIndexBytes,
      maxDocumentBytes: config.bounds?.maxDocumentBytes ?? defaultBounds.maxDocumentBytes,
      maxDocuments: config.bounds?.maxDocuments ?? defaultBounds.maxDocuments,
      maxOccurrences: config.bounds?.maxOccurrences ?? defaultBounds.maxOccurrences,
      maxSemanticEntries: config.bounds?.maxSemanticEntries ?? defaultBounds.maxSemanticEntries,
      maxResults: config.bounds?.maxResults ?? defaultBounds.maxResults,
    };
    assertPositiveInteger("bounds.maxIndexBytes", this.bounds.maxIndexBytes);
    assertPositiveInteger("bounds.maxDocumentBytes", this.bounds.maxDocumentBytes);
    assertPositiveInteger("bounds.maxDocuments", this.bounds.maxDocuments);
    assertPositiveInteger("bounds.maxOccurrences", this.bounds.maxOccurrences);
    assertPositiveInteger("bounds.maxSemanticEntries", this.bounds.maxSemanticEntries);
    assertPositiveInteger("bounds.maxResults", this.bounds.maxResults);
    this.timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    assertPositiveInteger("timeoutMs", this.timeoutMs);
    this.now = config.now ?? (() => new Date());
    this.readArtifact = config.readArtifact;
  }

  bindingFor(input: {
    projectId: string;
    revision: string;
  }): RepositoryIntelligenceSourceBinding | null {
    if (input.projectId !== this.manifest.projectId || input.revision !== this.manifest.revision) {
      return null;
    }
    return sourceBinding(this.manifest);
  }

  async query(input: RepositoryIntelligenceQuery): Promise<RepositoryIntelligenceResult> {
    const configuredSource = sourceBinding(this.manifest);
    const guard = new QueryGuard(this.timeoutMs, input.signal);
    try {
      guard.check();
      const requestFailure = this.validateRequest(input, configuredSource);
      if (requestFailure) return requestFailure;

      const ageFailure = this.validateAge(configuredSource);
      if (ageFailure) return ageFailure;

      let bytes: Uint8Array;
      let information: Awaited<ReturnType<FileHandle["stat"]>>;
      let handle: FileHandle | undefined;
      try {
        const artifactRootRealPath = await guard.wait(realpath(this.artifactRootPath));
        const preOpenLinkInformation = await guard.wait(lstat(this.indexPath));
        const preOpenRealPath = await guard.wait(realpath(this.indexPath));
        const preOpenPathInformation = await guard.wait(stat(preOpenRealPath));
        if (
          !preOpenLinkInformation.isFile() ||
          preOpenLinkInformation.isSymbolicLink() ||
          !preOpenPathInformation.isFile()
        ) {
          throw new ScipArtifactContainmentError(
            "The configured SCIP index must be a regular file, not a symbolic link.",
          );
        }
        if (!isWithin(artifactRootRealPath, preOpenRealPath)) {
          throw new ScipArtifactContainmentError(
            "The configured SCIP index physically escapes its manifest directory.",
          );
        }
        if (preOpenPathInformation.size > this.bounds.maxIndexBytes) {
          return failure(
            "PARTIAL",
            "The SCIP index exceeds the configured byte bound and was not read.",
            configuredSource,
            true,
            "PARTIAL",
          );
        }

        handle = await this.openReadOnly(this.indexPath, guard);
        information = await guard.wait(handle.stat());
        const postOpenLinkInformation = await guard.wait(lstat(this.indexPath));
        const postOpenRealPath = await guard.wait(realpath(this.indexPath));
        const postOpenPathInformation = await guard.wait(stat(postOpenRealPath));
        if (
          !information.isFile() ||
          !postOpenLinkInformation.isFile() ||
          postOpenLinkInformation.isSymbolicLink() ||
          !postOpenPathInformation.isFile() ||
          !isWithin(artifactRootRealPath, postOpenRealPath) ||
          !sameFileIdentity(information, preOpenPathInformation) ||
          !sameFileIdentity(information, postOpenPathInformation)
        ) {
          throw new ScipArtifactContainmentError(
            "The configured SCIP index changed while its file handle was being verified.",
          );
        }
        if (information.size > this.bounds.maxIndexBytes) {
          return failure(
            "PARTIAL",
            "The SCIP index grew beyond the configured byte bound before it was read.",
            configuredSource,
            true,
            "PARTIAL",
          );
        }
        bytes = this.readArtifact
          ? await guard.wait(this.readArtifact(handle, guard.signal))
          : await this.readBoundedHandle(handle, this.bounds.maxIndexBytes, guard);
      } catch (error) {
        if (error instanceof QueryInterruptedError) throw error;
        return failure(
          "UNAVAILABLE",
          error instanceof ScipArtifactContainmentError
            ? error.message
            : errno(error, "ENOENT") || errno(error, "ENOTDIR")
              ? "The configured SCIP index file is unavailable."
              : "The configured SCIP index file cannot be inspected.",
          configuredSource,
        );
      } finally {
        if (handle) await handle.close().catch(() => undefined);
      }
      guard.check();
      if (bytes.byteLength > this.bounds.maxIndexBytes) {
        return failure(
          "PARTIAL",
          "The SCIP index grew beyond the configured byte bound while being read.",
          configuredSource,
          true,
          "PARTIAL",
        );
      }
      const indexDigest = guardedSha256(bytes, guard);
      if (indexDigest !== this.manifest.indexSha256) {
        return failure(
          "STALE",
          "The SCIP index SHA-256 no longer matches its manifest binding.",
          configuredSource,
        );
      }

      const parsed = parseScipIndex(bytes, guard, this.bounds);
      if (parsed.metadata.protocolVersion !== 0) {
        throw new ScipVersionMismatchError(
          "The SCIP artifact protocol enum is not supported by the v0.9 decoder.",
        );
      }
      if (
        parsed.metadata.indexerName !== this.manifest.expectedIndexer.name ||
        parsed.metadata.indexerVersion !== this.manifest.expectedIndexer.version
      ) {
        throw new ScipVersionMismatchError(
          "The SCIP artifact indexer name/version does not match the manifest.",
        );
      }
      const effectiveLimit = Math.min(input.maxResults, this.bounds.maxResults);
      const model = buildSemanticModel(parsed, this.manifest, guard);
      const selected = await this.selectLocations(input, model, guard, effectiveLimit);
      if ("status" in selected) {
        guard.check();
        return selected;
      }

      const digestFailure = await this.revalidateLocationDocuments(
        input.repositoryPath,
        selected.locations,
        guard,
        configuredSource,
      );
      guard.check();
      if (digestFailure) return digestFailure;

      const truncated = model.truncated || selected.truncated;
      const completeness = model.truncated ? "PARTIAL" : this.manifest.completeness;
      const partial = truncated || completeness !== "COMPLETE";
      guard.check();
      return {
        status: partial ? "PARTIAL" : "COMPLETED",
        reason: partial
          ? "The bounded SCIP query completed with explicit partial coverage."
          : "The bounded SCIP query completed.",
        source: configuredSource,
        locations: selected.locations,
        truncated,
        completeness,
      };
    } catch (error) {
      if (error instanceof QueryInterruptedError) {
        return failure(
          "TIMEOUT",
          error.cause === "ABORTED"
            ? "The SCIP query was aborted before completion."
            : "The SCIP query exceeded its configured timeout.",
          configuredSource,
        );
      }
      if (error instanceof ScipVersionMismatchError) {
        return failure("VERSION_MISMATCH", error.message, configuredSource);
      }
      if (error instanceof MalformedScipError) {
        return failure("MALFORMED", error.message, configuredSource);
      }
      return failure(
        "MALFORMED",
        "The SCIP artifact could not be decoded safely.",
        configuredSource,
      );
    } finally {
      guard.dispose();
    }
  }

  private validateRequest(
    input: RepositoryIntelligenceQuery,
    source: RepositoryIntelligenceSourceBinding,
  ): RepositoryIntelligenceResult | null {
    if (
      !isAbsolute(input.repositoryPath) ||
      looksRemote(input.repositoryPath) ||
      looksLikeUncPath(input.repositoryPath)
    ) {
      return failure(
        "MALFORMED",
        "repositoryPath must be an absolute local filesystem path.",
        source,
      );
    }
    if (!Number.isSafeInteger(input.maxResults) || input.maxResults <= 0) {
      return failure("MALFORMED", "maxResults must be a positive safe integer.", source);
    }
    if (input.projectId !== this.manifest.projectId || input.revision !== this.manifest.revision) {
      return failure(
        "STALE",
        "The query project/revision does not match the SCIP manifest.",
        source,
      );
    }
    if (
      this.manifest.sourceId !== SCIP_SOURCE_ID ||
      this.manifest.sourceVersion !== SCIP_SOURCE_VERSION
    ) {
      return failure(
        "VERSION_MISMATCH",
        "The manifest does not bind the certified SCIP source and exact version.",
        source,
      );
    }
    if (input.expectedSource) {
      if (
        input.expectedSource.projectId !== source.projectId ||
        input.expectedSource.revision !== source.revision ||
        input.expectedSource.sourceDigest !== source.sourceDigest ||
        input.expectedSource.indexedAt !== source.indexedAt ||
        input.expectedSource.completeness !== source.completeness ||
        !sameStrings(input.expectedSource.languages, source.languages)
      ) {
        return failure("STALE", "The expected repository-intelligence binding is stale.", source);
      }
      if (
        input.expectedSource.sourceId !== source.sourceId ||
        input.expectedSource.sourceVersion !== source.sourceVersion
      ) {
        return failure(
          "VERSION_MISMATCH",
          "The expected repository-intelligence source/version does not match.",
          source,
        );
      }
    }
    if (input.language) {
      const requested = input.language.toLocaleLowerCase("en-US");
      if (
        !this.manifest.languages.some(
          (language) => language.toLocaleLowerCase("en-US") === requested,
        )
      ) {
        return failure(
          "UNSUPPORTED",
          "The requested language is not covered by this SCIP artifact.",
          source,
        );
      }
    }
    if (input.operation === "FIND_SYMBOL") {
      if (!nonEmptyBoundedText(input.query, 512)) {
        return failure("MALFORMED", "FIND_SYMBOL requires a bounded query string.", source);
      }
    } else {
      const anchor = input.anchor;
      if (
        !anchor ||
        !isCanonicalRelativePath(anchor.uri) ||
        !nonEmptyBoundedText(anchor.name, 512) ||
        !Number.isSafeInteger(anchor.line) ||
        anchor.line <= 0 ||
        !sha256Pattern.test(anchor.documentDigest)
      ) {
        return failure(
          "MALFORMED",
          "Semantic navigation requires a canonical uri/line/name/documentDigest anchor.",
          source,
        );
      }
    }
    return null;
  }

  private validateAge(
    source: RepositoryIntelligenceSourceBinding,
  ): RepositoryIntelligenceResult | null {
    const indexedAt = Date.parse(this.manifest.indexedAt);
    const now = this.now().getTime();
    if (!Number.isFinite(now) || now < indexedAt || now - indexedAt > this.manifest.maxAgeMs) {
      return failure(
        "STALE",
        "The SCIP artifact is outside its exact manifest age window.",
        source,
      );
    }
    return null;
  }

  private async openReadOnly(filePath: string, guard: QueryGuard): Promise<FileHandle> {
    guard.check();
    const opening = open(filePath, "r");
    let claimed = false;
    try {
      const handle = await guard.wait(opening);
      try {
        guard.check();
      } catch (error) {
        claimed = true;
        await handle.close().catch(() => undefined);
        throw error;
      }
      claimed = true;
      return handle;
    } catch (error) {
      if (!claimed) {
        void opening.then(
          async (handle) => await handle.close().catch(() => undefined),
          () => undefined,
        );
      }
      throw error;
    }
  }

  private async readBoundedHandle(
    handle: FileHandle,
    maximumBytes: number,
    guard: QueryGuard,
  ): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position <= maximumBytes) {
      guard.check();
      const remaining = maximumBytes - position;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, remaining + 1));
      const { bytesRead } = await guard.wait(handle.read(chunk, 0, chunk.byteLength, position));
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    guard.check();
    return Buffer.concat(chunks, position);
  }

  private async selectLocations(
    input: RepositoryIntelligenceQuery,
    model: SemanticModel,
    guard: QueryGuard,
    resultLimit: number,
  ): Promise<
    | { locations: RepositoryIntelligenceLocation[]; truncated: boolean }
    | RepositoryIntelligenceResult
  > {
    const source = sourceBinding(this.manifest);
    let work = 0;
    const checkpoint = (): void => {
      checkGuardPeriodically(guard, work);
      work += 1;
    };
    guard.check();
    if (input.operation === "FIND_SYMBOL") {
      const query = input.query?.toLocaleLowerCase("en-US") ?? "";
      const collector = new BoundedLocationCollector(resultLimit, guard);
      for (const occurrence of model.occurrences) {
        checkpoint();
        const name = model.names.get(occurrence.symbolKey);
        if (
          !occurrence.definition ||
          !name?.toLocaleLowerCase("en-US").includes(query) ||
          !this.matchesLanguage(occurrence.document.language, input.language)
        ) {
          continue;
        }
        collector.add(this.location(occurrence, name, "DEFINITION"));
      }
      return collector.finish();
    }

    const anchor = input.anchor;
    if (!anchor) {
      return failure("MALFORMED", "The semantic query is missing its anchor.", source);
    }
    const document = model.documents.get(anchor.uri);
    const manifestDigest = this.documentDigests.get(anchor.uri);
    if (!document || !manifestDigest) {
      return failure(
        "STALE",
        "The anchor document is not bound by the SCIP index and manifest.",
        source,
      );
    }
    if (manifestDigest !== anchor.documentDigest) {
      return failure("STALE", "The anchor document digest is stale.", source);
    }
    const anchorFailure = await this.revalidateDocument(
      input.repositoryPath,
      anchor.uri,
      anchor.documentDigest,
      guard,
      source,
    );
    if (anchorFailure) return anchorFailure;

    let anchorKey: string | null = null;
    let ambiguousAnchor = false;
    for (const occurrence of model.occurrences) {
      checkpoint();
      if (
        occurrence.document.uri !== anchor.uri ||
        occurrence.range.startLine + 1 !== anchor.line ||
        model.names.get(occurrence.symbolKey) !== anchor.name ||
        !this.matchesLanguage(occurrence.document.language, input.language)
      ) {
        continue;
      }
      if (anchorKey === null) anchorKey = occurrence.symbolKey;
      else if (anchorKey !== occurrence.symbolKey) ambiguousAnchor = true;
    }
    if (!anchorKey || ambiguousAnchor) {
      return failure(
        "UNAVAILABLE",
        !anchorKey
          ? "No SCIP symbol matches the complete canonical anchor."
          : "The canonical anchor resolves to more than one SCIP symbol.",
        source,
      );
    }

    if (input.operation === "FIND_DEFINITION") {
      const targets = new Set([anchorKey]);
      for (const relationship of model.relationships) {
        checkpoint();
        if (relationship.source === anchorKey && relationship.isDefinition) {
          targets.add(relationship.target);
        }
      }
      return this.locationsForSymbols(
        model,
        targets,
        true,
        "DEFINITION",
        input.language,
        anchorKey,
        anchor.name,
        guard,
        resultLimit,
      );
    }
    if (input.operation === "FIND_REFERENCES") {
      const targets = new Set([anchorKey]);
      for (const relationship of model.relationships) {
        checkpoint();
        if (!relationship.isReference) continue;
        if (relationship.source === anchorKey) targets.add(relationship.target);
        if (relationship.target === anchorKey) targets.add(relationship.source);
      }
      return this.locationsForSymbols(
        model,
        targets,
        false,
        "REFERENCE",
        input.language,
        anchorKey,
        anchor.name,
        guard,
        resultLimit,
      );
    }
    const implementations = new Set<string>();
    for (const relationship of model.relationships) {
      checkpoint();
      if (relationship.target === anchorKey && relationship.isImplementation) {
        implementations.add(relationship.source);
      }
    }
    return this.locationsForSymbols(
      model,
      implementations,
      true,
      "IMPLEMENTATION",
      input.language,
      anchorKey,
      anchor.name,
      guard,
      resultLimit,
    );
  }

  private locationsForSymbols(
    model: SemanticModel,
    symbols: Set<string>,
    definition: boolean,
    role: RepositoryIntelligenceLocation["role"],
    language: string | undefined,
    anchorKey: string,
    anchorName: string,
    guard: QueryGuard,
    resultLimit: number,
  ): { locations: RepositoryIntelligenceLocation[]; truncated: boolean } {
    const collector = new BoundedLocationCollector(resultLimit, guard);
    let work = 0;
    for (const occurrence of model.occurrences) {
      checkGuardPeriodically(guard, work);
      work += 1;
      if (
        occurrence.definition !== definition ||
        !symbols.has(occurrence.symbolKey) ||
        !this.matchesLanguage(occurrence.document.language, language)
      ) {
        continue;
      }
      const name =
        occurrence.symbolKey === anchorKey ? anchorName : model.names.get(occurrence.symbolKey);
      if (name) collector.add(this.location(occurrence, name, role));
    }
    return collector.finish();
  }

  private location(
    occurrence: IndexedOccurrence,
    name: string,
    role: RepositoryIntelligenceLocation["role"],
  ): RepositoryIntelligenceLocation {
    const digest = this.documentDigests.get(occurrence.document.uri);
    if (!digest) throw new MalformedScipError("A result document lacks a manifest digest.");
    return {
      uri: occurrence.document.uri,
      name,
      language: occurrence.document.language,
      role,
      range: {
        startLine: occurrence.range.startLine + 1,
        startCharacter: occurrence.range.startCharacter,
        endLine: occurrence.range.endLine + 1,
        endCharacter: occurrence.range.endCharacter,
        encoding: encodingFor(occurrence.document.positionEncoding),
      },
      documentDigest: digest,
    };
  }

  private matchesLanguage(documentLanguage: string, requested?: string): boolean {
    return (
      requested === undefined ||
      documentLanguage.toLocaleLowerCase("en-US") === requested.toLocaleLowerCase("en-US")
    );
  }

  private async revalidateLocationDocuments(
    repositoryPath: string,
    locations: readonly RepositoryIntelligenceLocation[],
    guard: QueryGuard,
    source: RepositoryIntelligenceSourceBinding,
  ): Promise<RepositoryIntelligenceResult | null> {
    const documents = new Map<string, string>();
    for (const location of locations) documents.set(location.uri, location.documentDigest);
    for (const [uri, digest] of [...documents].sort(([left], [right]) =>
      left.localeCompare(right, "en"),
    )) {
      const result = await this.revalidateDocument(repositoryPath, uri, digest, guard, source);
      if (result) return result;
    }
    return null;
  }

  private async revalidateDocument(
    repositoryPathInput: string,
    uri: string,
    expectedDigest: string,
    guard: QueryGuard,
    source: RepositoryIntelligenceSourceBinding,
  ): Promise<RepositoryIntelligenceResult | null> {
    const repositoryPath = resolve(repositoryPathInput);
    const absolutePath = resolve(repositoryPath, ...uri.split("/"));
    if (!isWithin(repositoryPath, absolutePath) || absolutePath === repositoryPath) {
      return failure("MALFORMED", "A result document path escapes repositoryPath.", source);
    }
    let handle: FileHandle | undefined;
    try {
      const repositoryRealPath = await guard.wait(realpath(repositoryPath));
      const preOpenLinkInformation = await guard.wait(lstat(absolutePath));
      const preOpenRealPath = await guard.wait(realpath(absolutePath));
      const preOpenPathInformation = await guard.wait(stat(preOpenRealPath));
      if (
        !preOpenLinkInformation.isFile() ||
        preOpenLinkInformation.isSymbolicLink() ||
        !preOpenPathInformation.isFile()
      ) {
        return failure(
          "STALE",
          "A manifest-bound source document is no longer a regular file.",
          source,
        );
      }
      if (!isWithin(repositoryRealPath, preOpenRealPath)) {
        return failure(
          "STALE",
          "A manifest-bound source document escapes the repository through its path.",
          source,
        );
      }
      if (preOpenPathInformation.size > this.bounds.maxDocumentBytes) {
        return failure(
          "PARTIAL",
          "A manifest-bound source document exceeds the configured byte bound.",
          source,
          true,
          "PARTIAL",
        );
      }

      handle = await this.openReadOnly(absolutePath, guard);
      const handleInformation = await guard.wait(handle.stat());
      const postOpenLinkInformation = await guard.wait(lstat(absolutePath));
      const postOpenRealPath = await guard.wait(realpath(absolutePath));
      const postOpenPathInformation = await guard.wait(stat(postOpenRealPath));
      if (
        !handleInformation.isFile() ||
        !postOpenLinkInformation.isFile() ||
        postOpenLinkInformation.isSymbolicLink() ||
        !postOpenPathInformation.isFile() ||
        !isWithin(repositoryRealPath, postOpenRealPath) ||
        !sameFileIdentity(handleInformation, preOpenPathInformation) ||
        !sameFileIdentity(handleInformation, postOpenPathInformation)
      ) {
        return failure(
          "STALE",
          "A manifest-bound source document changed while its file handle was being verified.",
          source,
        );
      }
      if (handleInformation.size > this.bounds.maxDocumentBytes) {
        return failure(
          "PARTIAL",
          "A manifest-bound source document grew beyond the configured byte bound before reading.",
          source,
          true,
          "PARTIAL",
        );
      }
      const bytes = await this.readBoundedHandle(handle, this.bounds.maxDocumentBytes, guard);
      if (bytes.byteLength > this.bounds.maxDocumentBytes) {
        return failure(
          "PARTIAL",
          "A manifest-bound source document grew beyond the configured byte bound.",
          source,
          true,
          "PARTIAL",
        );
      }
      const documentDigest = guardedSha256(bytes, guard);
      if (documentDigest !== expectedDigest) {
        return failure("STALE", "A manifest-bound source document SHA-256 is stale.", source);
      }
      return null;
    } catch (error) {
      if (error instanceof QueryInterruptedError) throw error;
      if (errno(error, "ENOENT") || errno(error, "ENOTDIR")) {
        return failure("STALE", "A manifest-bound source document is unavailable.", source);
      }
      return failure(
        "UNAVAILABLE",
        "A manifest-bound source document cannot be revalidated.",
        source,
      );
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }
}
