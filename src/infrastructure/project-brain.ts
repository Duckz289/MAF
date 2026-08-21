import type {
  KnowledgeKind,
  KnowledgeRecord,
  ProjectBrain,
  RepositoryIndex,
  RepositoryIndexStatus,
  RepositorySnapshot,
} from "../domain/ports";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { moduleOwnerForFile, packageOwnerForFile } from "../domain/module-ownership";

export class InMemoryProjectBrain implements ProjectBrain {
  private readonly records = new Map<string, KnowledgeRecord>();

  async add(record: KnowledgeRecord): Promise<void> {
    if (record.kind === "FACT" && record.evidenceIds.length === 0) {
      throw new Error("Facts require at least one evidence record");
    }
    this.records.set(record.id, structuredClone(record));
  }

  async list(
    projectId: string,
    revision: string,
    kinds?: KnowledgeKind[],
  ): Promise<KnowledgeRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.projectId === projectId &&
          record.revision === revision &&
          record.status === "ACTIVE" &&
          (!kinds || kinds.includes(record.kind)),
      )
      .map((record) => structuredClone(record));
  }

  async markStale(projectId: string, activeRevision: string): Promise<number> {
    let count = 0;
    for (const record of this.records.values()) {
      if (
        record.projectId === projectId &&
        record.revision !== activeRevision &&
        record.status === "ACTIVE"
      ) {
        record.status = "STALE";
        count += 1;
      }
    }
    return count;
  }
}

const execCapture = async (command: string, args: string[], cwd: string): Promise<string> => {
  const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`${command} failed (${code}): ${stderr.trim()}`);
  return stdout;
};

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const workspacePatterns = async (repositoryPath: string, files: string[]): Promise<string[]> => {
  const patterns: string[] = [];
  if (files.includes("package.json")) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(repositoryPath, "package.json"), "utf8"),
      ) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const workspaces = Array.isArray(manifest.workspaces)
        ? manifest.workspaces
        : (manifest.workspaces?.packages ?? []);
      patterns.push(...workspaces);
    } catch {
      // An invalid manifest cannot be trusted as workspace evidence.
    }
  }
  if (files.includes("pnpm-workspace.yaml")) {
    try {
      const yaml = await readFile(path.join(repositoryPath, "pnpm-workspace.yaml"), "utf8");
      for (const line of yaml.split(/\r?\n/u)) {
        const match = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/u);
        if (match?.[1]) patterns.push(match[1].trim());
      }
    } catch {
      // Workspace hints are optional; tracked-file conventions remain available.
    }
  }
  return [...new Set(patterns)];
};

const rootsForPattern = (pattern: string, files: string[]): string[] => {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!normalized.includes("*"))
    return files.some((file) => file.startsWith(`${normalized}/`)) ? [normalized] : [];
  const prefix = normalized.slice(0, normalized.indexOf("*")).replace(/\/$/u, "");
  const depth = prefix.split("/").filter(Boolean).length + 1;
  return files
    .filter((file) => file.startsWith(`${prefix}/`))
    .map((file) => file.split("/").slice(0, depth).join("/"))
    .filter(Boolean);
};

const discoverModuleRoots = async (repositoryPath: string, files: string[]): Promise<string[]> => {
  const roots = new Set<string>();
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    if (normalized.endsWith("/package.json")) roots.add(path.posix.dirname(normalized));
    const segments = normalized.split("/");
    if (["apps", "packages", "services"].includes(segments[0] ?? "") && segments[1]) {
      roots.add(`${segments[0]}/${segments[1]}`);
    }
  }
  for (const pattern of await workspacePatterns(repositoryPath, files)) {
    for (const root of rootsForPattern(pattern, files)) roots.add(root);
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
};

const resolveLocalImport = (
  from: string,
  specifier: string,
  repositoryFiles: Set<string>,
): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => repositoryFiles.has(candidate));
};

const isSourceFile = (file: string): boolean => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(file);

/** Safety ceiling on the tracked-file list. Exceeding it is recorded, never silently dropped. */
const MAX_TRACKED_FILES = 100_000;
/** Safety ceiling on symbols/relations parsed by a single indexScope call. */
const MAX_SCOPE_FILES_PER_CALL = 2_000;

const parseFileDeclarations = (
  file: string,
  source: string,
  repositoryFiles: Set<string>,
): Pick<RepositorySnapshot, "symbols" | "relations"> => {
  const symbols: RepositorySnapshot["symbols"] = [];
  const relations: RepositorySnapshot["relations"] = [];
  const lines = source.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const declaration = line.match(
      /(?:export\s+)?(?:async\s+)?(?:class|function|interface|type|const)\s+([A-Za-z_$][\w$]*)/u,
    );
    if (declaration?.[1]) {
      symbols.push({
        name: declaration[1],
        kind: line.includes("class ")
          ? "class"
          : line.includes("interface ")
            ? "interface"
            : "symbol",
        file,
        line: index + 1,
      });
    }
    for (const match of line.matchAll(
      /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/gu,
    )) {
      if (!match[1]) continue;
      const target = resolveLocalImport(file, match[1], repositoryFiles);
      if (target) relations.push({ from: file, to: target, kind: "IMPORTS" });
    }
  });
  return { symbols, relations };
};

/**
 * Deterministic, bounded, incrementally-cacheable repository index. `index()` is a cheap
 * path-only pass safe to run on every task regardless of repository size; `indexScope()` parses
 * exactly the requested files. The snapshot's own per-file evidence digest IS the cache: a file
 * whose digest hasn't changed since it was last recorded is never re-parsed, and a file whose
 * digest HAS changed always is — this cache is naturally scoped to the snapshot/run it belongs to
 * (no unbounded process-lifetime state) and staleness is checked live on every call rather than
 * gated behind "has this file ever been requested before".
 */
export class LocalRepositoryIndex implements RepositoryIndex {
  readonly name = "local-deterministic-index";

  status(): RepositoryIndexStatus {
    return {
      engine: this.name,
      capability: "LOCAL_DETERMINISTIC",
      active: true,
      detail:
        "Tracked files, symbols, resolved local imports, module/package ownership, and ast-grep",
    };
  }

  async index(repositoryPath: string, revision: string): Promise<RepositorySnapshot> {
    const raw = await execCapture("git", ["ls-files"], repositoryPath);
    const allFiles = raw
      .split(/\r?\n/u)
      .map((file) => file.trim())
      .filter(Boolean);
    const filesTruncated = allFiles.length > MAX_TRACKED_FILES;
    const files = filesTruncated ? allFiles.slice(0, MAX_TRACKED_FILES) : allFiles;
    const moduleRoots = await discoverModuleRoots(repositoryPath, files);
    const moduleMap: Record<string, string[]> = {};
    const moduleOwnership: Record<string, string> = {};
    const packageOwnership: Record<string, string> = {};
    // Path-only pass: no file content is read, so this stays cheap at any repository size and
    // never silently omits files from the module/package graph the way a content-parse cap would.
    for (const file of files) {
      if (!isSourceFile(file)) continue;
      const normalizedFile = file.replaceAll("\\", "/");
      const module = moduleOwnerForFile(normalizedFile, moduleRoots);
      packageOwnership[normalizedFile] = packageOwnerForFile(normalizedFile, moduleRoots);
      moduleOwnership[normalizedFile] = module;
      moduleMap[module] = [...(moduleMap[module] ?? []), file];
    }
    for (const moduleFiles of Object.values(moduleMap)) moduleFiles.sort();
    return {
      revision,
      files,
      filesTruncated,
      symbols: [],
      relations: [],
      moduleMap,
      moduleOwnership,
      packageOwnership,
      moduleRoots,
      parsedFiles: [],
      scopeTruncated: false,
      evidence: [],
    };
  }

  async indexScope(
    repositoryPath: string,
    _revision: string,
    snapshot: RepositorySnapshot,
    requestedFiles: string[],
  ): Promise<RepositorySnapshot> {
    const knownFiles = new Set(snapshot.files.map((file) => file.replaceAll("\\", "/")));
    const requested = [...new Set(requestedFiles.map((file) => file.replaceAll("\\", "/")))].filter(
      isSourceFile,
    );
    if (requested.length === 0) return snapshot;

    // A file the agent created mid-run is invisible to the frozen initial git ls-files pass.
    // Register any requested file that genuinely exists on disk but isn't in the snapshot yet, so
    // it can still be parsed and act as an import target, using the same path-only classification
    // index() uses.
    const newlyRegistered = requested.filter(
      (file) => !knownFiles.has(file) && existsSync(path.join(repositoryPath, file)),
    );
    for (const file of newlyRegistered) knownFiles.add(file);
    let files = snapshot.files;
    let moduleMap = snapshot.moduleMap;
    let moduleOwnership = snapshot.moduleOwnership;
    let packageOwnership = snapshot.packageOwnership;
    if (newlyRegistered.length > 0) {
      files = [...files, ...newlyRegistered].sort();
      moduleMap = { ...moduleMap };
      moduleOwnership = { ...moduleOwnership };
      packageOwnership = { ...packageOwnership };
      for (const file of newlyRegistered) {
        const module = moduleOwnerForFile(file, snapshot.moduleRoots);
        packageOwnership[file] = packageOwnerForFile(file, snapshot.moduleRoots);
        moduleOwnership[file] = module;
        moduleMap[module] = [...(moduleMap[module] ?? []), file].sort();
      }
    }

    const scopeTruncated = requested.length > MAX_SCOPE_FILES_PER_CALL;
    const candidates = requested.slice(0, MAX_SCOPE_FILES_PER_CALL);
    const evidenceByFile = new Map(snapshot.evidence.map((entry) => [entry.uri, entry.digest]));
    const changedFiles = new Set<string>();
    const newlyAttempted: string[] = [];
    const newSymbols: RepositorySnapshot["symbols"] = [];
    const newRelations: RepositorySnapshot["relations"] = [];
    const newEvidence: RepositorySnapshot["evidence"] = [];
    await Promise.all(
      candidates.map(async (file) => {
        const absolute = path.join(repositoryPath, file);
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
          fileStat = await stat(absolute);
        } catch {
          // Tracked but absent in this worktree (e.g. deleted on this branch); nothing to parse,
          // but it must still count as attempted so a future call does not retry forever.
          newlyAttempted.push(file);
          return;
        }
        if (fileStat.size > 1_000_000) {
          newlyAttempted.push(file);
          return;
        }
        const source = await readFile(absolute, "utf8");
        const digest = createHash("sha256").update(source).digest("hex");
        newlyAttempted.push(file);
        // The snapshot's own recorded digest for this file IS the cache: unchanged content means
        // the symbols/relations already merged in remain correct and nothing needs to be redone.
        if (evidenceByFile.get(file) === digest) return;
        changedFiles.add(file);
        const parsed = parseFileDeclarations(file, source, knownFiles);
        newSymbols.push(...parsed.symbols);
        newRelations.push(...parsed.relations);
        newEvidence.push({ uri: file, digest });
      }),
    );

    const parsedFilesUnchanged = newlyAttempted.every((file) =>
      snapshot.parsedFiles.includes(file),
    );
    const parsedFiles = parsedFilesUnchanged
      ? snapshot.parsedFiles
      : [...new Set([...snapshot.parsedFiles, ...newlyAttempted])].sort();
    if (changedFiles.size === 0 && newlyRegistered.length === 0 && parsedFilesUnchanged) {
      return snapshot;
    }

    // A changed file's own prior symbols/relations are dropped before its fresh parse is added;
    // relations FROM other unchanged files stay valid regardless (their target existing is what
    // matters, not the target's own content), so only relations FROM a changed file are dropped.
    const symbols =
      changedFiles.size === 0
        ? snapshot.symbols
        : [
            ...snapshot.symbols.filter((symbol) => !changedFiles.has(symbol.file)),
            ...newSymbols,
          ].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    const relations =
      changedFiles.size === 0
        ? snapshot.relations
        : [
            ...snapshot.relations.filter((relation) => !changedFiles.has(relation.from)),
            ...newRelations,
          ].sort(
            (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
          );
    const evidence =
      changedFiles.size === 0
        ? snapshot.evidence
        : [
            ...snapshot.evidence.filter((entry) => !changedFiles.has(entry.uri)),
            ...newEvidence,
          ].sort((left, right) => left.uri.localeCompare(right.uri));

    return {
      ...snapshot,
      files,
      moduleMap,
      moduleOwnership,
      packageOwnership,
      symbols,
      relations,
      evidence,
      parsedFiles,
      scopeTruncated,
    };
  }

  async structuralSearch(
    repositoryPath: string,
    language: string,
    pattern: string,
  ): Promise<string[]> {
    try {
      const astGrep = await import("@ast-grep/napi");
      const lang = astGrep.Lang[language as keyof typeof astGrep.Lang];
      if (!lang) return [];
      const snapshot = await this.index(repositoryPath, "working-tree");
      const results: string[] = [];
      for (const file of snapshot.files.filter((candidate) =>
        /\.(?:ts|tsx|js|jsx)$/u.test(candidate),
      )) {
        const source = await readFile(path.join(repositoryPath, file), "utf8");
        const root = astGrep.parse(lang, source).root();
        for (const node of root.findAll(pattern))
          results.push(`${file}:${node.range().start.line + 1}`);
      }
      return results;
    } catch {
      const output = await execCapture(
        "rg",
        ["-n", "--fixed-strings", pattern, "."],
        repositoryPath,
      );
      return output.split(/\r?\n/u).filter(Boolean);
    }
  }
}

export class OptionalCodebaseMemoryIndex implements RepositoryIndex {
  readonly name: string;

  constructor(private readonly fallback: RepositoryIndex) {
    this.name = `optional-codebase-memory-port:fallback=${fallback.name}`;
  }

  async index(repositoryPath: string, revision: string): Promise<RepositorySnapshot> {
    return this.fallback.index(repositoryPath, revision);
  }

  async indexScope(
    repositoryPath: string,
    revision: string,
    snapshot: RepositorySnapshot,
    files: string[],
  ): Promise<RepositorySnapshot> {
    return this.fallback.indexScope(repositoryPath, revision, snapshot, files);
  }

  structuralSearch(repositoryPath: string, language: string, pattern: string): Promise<string[]> {
    return this.fallback.structuralSearch(repositoryPath, language, pattern);
  }

  status(): RepositoryIndexStatus {
    return {
      engine: this.name,
      capability: "OPTIONAL_PORT",
      active: false,
      fallbackEngine: this.fallback.name,
      detail: "No MCP session is configured; the deterministic local index is active",
    };
  }
}

/** @deprecated Compatibility alias. This is an optional port, not an active MCP session. */
export { OptionalCodebaseMemoryIndex as CodebaseMemoryMcpIndex };
