/**
 * Provider-neutral semantic navigation. Results are revision/source bound context locators, never
 * verification evidence or architectural intent.
 */
export type RepositoryIntelligenceOperation =
  | "FIND_SYMBOL"
  | "FIND_DEFINITION"
  | "FIND_REFERENCES"
  | "FIND_IMPLEMENTATIONS";

export type RepositoryIntelligenceStatus =
  | "COMPLETED"
  | "UNAVAILABLE"
  | "UNSUPPORTED"
  | "TIMEOUT"
  | "MALFORMED"
  | "PARTIAL"
  | "STALE"
  | "VERSION_MISMATCH";

export type RepositoryIntelligenceCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export interface RepositoryIntelligenceSourceBinding {
  projectId: string;
  revision: string;
  sourceId: string;
  sourceDigest: string;
  sourceVersion: string;
  indexedAt: string;
  completeness: RepositoryIntelligenceCompleteness;
  languages: string[];
}

export interface RepositoryIntelligenceSymbolAnchor {
  uri: string;
  name: string;
  /** One-based source line, consistent with repository and Context OS symbol locators. */
  line: number;
  documentDigest: string;
}

export interface RepositoryIntelligenceLocation {
  uri: string;
  name: string;
  language: string;
  role: "DEFINITION" | "REFERENCE" | "IMPLEMENTATION";
  /** One-based lines and zero-based characters. */
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    encoding: "UTF8_CODE_UNIT" | "UTF16_CODE_UNIT" | "UTF32_CODE_UNIT" | "UNKNOWN";
  };
  /** Digest of the exact source document indexed for this location. */
  documentDigest: string;
}

export interface RepositoryIntelligenceQuery {
  operation: RepositoryIntelligenceOperation;
  repositoryPath: string;
  projectId: string;
  revision: string;
  expectedSource?: RepositoryIntelligenceSourceBinding;
  query?: string;
  language?: string;
  anchor?: RepositoryIntelligenceSymbolAnchor;
  maxResults: number;
  signal?: AbortSignal;
}

export interface RepositoryIntelligenceResult {
  status: RepositoryIntelligenceStatus;
  reason: string;
  source: RepositoryIntelligenceSourceBinding | null;
  locations: RepositoryIntelligenceLocation[];
  truncated: boolean;
  completeness: RepositoryIntelligenceCompleteness;
}

export interface RepositoryIntelligenceProvider {
  readonly name: string;
  /**
   * Returns only a configured locator binding. Query-time resolution must revalidate the artifact,
   * revision, version, age, and document digests before returning semantic locations.
   */
  bindingFor(input: {
    projectId: string;
    revision: string;
  }): RepositoryIntelligenceSourceBinding | null;
  query(input: RepositoryIntelligenceQuery): Promise<RepositoryIntelligenceResult>;
}
