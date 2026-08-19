import type {
  KnowledgeKind,
  KnowledgeRecord,
  ProjectBrain,
  RepositoryIndex,
  RepositoryIndexStatus,
  RepositorySnapshot,
} from "../domain/ports";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { moduleOwnerForFile } from "../domain/module-ownership";

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

export class LocalRepositoryIndex implements RepositoryIndex {
  readonly name = "local-deterministic-index";

  status(): RepositoryIndexStatus {
    return {
      engine: this.name,
      capability: "LOCAL_DETERMINISTIC",
      active: true,
      detail: "Tracked files, symbols, resolved local imports, module ownership, and ast-grep",
    };
  }

  async index(repositoryPath: string, revision: string): Promise<RepositorySnapshot> {
    const raw = await execCapture("git", ["ls-files"], repositoryPath);
    const files = raw
      .split(/\r?\n/u)
      .map((file) => file.trim())
      .filter(Boolean)
      .slice(0, 4_000);
    const sourceFiles = files.filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(file));
    const repositoryFiles = new Set(files.map((file) => file.replaceAll("\\", "/")));
    const symbols: RepositorySnapshot["symbols"] = [];
    const relations: RepositorySnapshot["relations"] = [];
    const moduleMap: Record<string, string[]> = {};
    const moduleOwnership: Record<string, string> = {};
    const evidence: RepositorySnapshot["evidence"] = [];
    const moduleRoots = await discoverModuleRoots(repositoryPath, files);

    await Promise.all(
      sourceFiles.slice(0, 500).map(async (file) => {
        const absolute = path.join(repositoryPath, file);
        const fileStat = await stat(absolute);
        if (fileStat.size > 1_000_000) return;
        const source = await readFile(absolute, "utf8");
        evidence.push({
          uri: file,
          digest: createHash("sha256").update(source).digest("hex"),
        });
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
          for (const match of line.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/gu)) {
            if (!match[1]) continue;
            const target = resolveLocalImport(file, match[1], repositoryFiles);
            if (target) relations.push({ from: file, to: target, kind: "IMPORTS" });
          }
        });
        const normalizedFile = file.replaceAll("\\", "/");
        const module = moduleOwnerForFile(normalizedFile, moduleRoots);
        moduleOwnership[normalizedFile] = module;
        moduleMap[module] = [...(moduleMap[module] ?? []), file];
      }),
    );

    symbols.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    relations.sort(
      (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
    );
    evidence.sort((left, right) => left.uri.localeCompare(right.uri));
    for (const moduleFiles of Object.values(moduleMap)) moduleFiles.sort();
    return {
      revision,
      files,
      symbols,
      relations,
      moduleMap,
      moduleOwnership,
      moduleRoots,
      evidence,
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
