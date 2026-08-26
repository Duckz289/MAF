import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, readlink, rm } from "node:fs/promises";
import path from "node:path";
import type { Sandbox, SandboxDiff, SandboxProvider } from "../domain/ports";
import { runProcess } from "./process-utils";

export type SandboxRetention = "none" | "failed" | "all";

interface GitEntry {
  mode: string;
  oid: string;
  type: "blob" | "commit";
}

interface WorkspaceEntry {
  mode: string;
  bytes: Buffer;
  oid: string;
  digest: string;
}

const MAX_CAPTURE_FILES = 50_000;
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

const gitObjectId = (bytes: Buffer, algorithm: "sha1" | "sha256"): string =>
  createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");

const rawGit = async (cwd: string, args: string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString("utf8") || `git exited ${code}`));
    });
  });

const parseTree = (value: string): Map<string, GitEntry> => {
  const entries = new Map<string, GitEntry>();
  for (const record of value.split("\0").filter(Boolean)) {
    const match = record.match(/^(\d{6}) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/u);
    const [, mode, type, oid, file] = match ?? [];
    if (!mode || !type || !oid || !file) {
      throw new Error("Unable to parse immutable base tree entry");
    }
    entries.set(file.replace(/\\/gu, "/"), {
      mode,
      type: type as "blob" | "commit",
      oid,
    });
  }
  return entries;
};

const parseIndex = (value: string): Map<string, GitEntry> => {
  const entries = new Map<string, GitEntry>();
  for (const record of value.split("\0").filter(Boolean)) {
    const match = record.match(/^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/u);
    const [, mode, oid, stage, file] = match ?? [];
    if (!mode || !oid || stage !== "0" || !file) {
      throw new Error("Candidate index contains an unresolved or unparseable entry");
    }
    entries.set(file.replace(/\\/gu, "/"), {
      mode,
      type: mode === "160000" ? "commit" : "blob",
      oid,
    });
  }
  return entries;
};

const sameGitEntry = (left: GitEntry | undefined, right: GitEntry | undefined): boolean =>
  left?.mode === right?.mode && left?.oid === right?.oid && left?.type === right?.type;

const quotePath = (prefix: "a" | "b", file: string): string => JSON.stringify(`${prefix}/${file}`);

const textFrom = (bytes: Buffer): string | undefined => {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

type LineOperation = { kind: "EQUAL" | "DELETE" | "INSERT"; line: string };

const boundedLineDiff = (oldLines: string[], newLines: string[]): LineOperation[] => {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const before = oldLines.slice(0, prefix).map((line) => ({ kind: "EQUAL" as const, line }));
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const after = oldLines
    .slice(oldLines.length - suffix)
    .map((line) => ({ kind: "EQUAL" as const, line }));

  // Exact deterministic LCS for ordinary source files. The bound prevents adversarial large-file
  // quadratic allocation; the fallback remains a valid, conservative transformation.
  if ((oldMiddle.length + 1) * (newMiddle.length + 1) > 1_000_000) {
    return [
      ...before,
      ...oldMiddle.map((line) => ({ kind: "DELETE" as const, line })),
      ...newMiddle.map((line) => ({ kind: "INSERT" as const, line })),
      ...after,
    ];
  }
  const columns = newMiddle.length + 1;
  const table = new Uint32Array((oldMiddle.length + 1) * columns);
  const tableAt = (row: number, column: number): number => table[row * columns + column] ?? 0;
  for (let oldIndex = oldMiddle.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newMiddle.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * columns + newIndex;
      table[offset] =
        oldMiddle[oldIndex] === newMiddle[newIndex]
          ? tableAt(oldIndex + 1, newIndex + 1) + 1
          : Math.max(tableAt(oldIndex + 1, newIndex), tableAt(oldIndex, newIndex + 1));
    }
  }
  const middle: LineOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldMiddle.length || newIndex < newMiddle.length) {
    const oldLine = oldMiddle[oldIndex];
    const newLine = newMiddle[newIndex];
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      middle.push({ kind: "EQUAL", line: oldLine });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      oldLine !== undefined &&
      (newIndex >= newMiddle.length ||
        tableAt(oldIndex + 1, newIndex) >= tableAt(oldIndex, newIndex + 1))
    ) {
      middle.push({ kind: "DELETE", line: oldLine });
      oldIndex += 1;
    } else if (newLine !== undefined) {
      middle.push({ kind: "INSERT", line: newLine });
      newIndex += 1;
    } else {
      throw new Error("Unable to render the literal candidate text projection");
    }
  }
  return [...before, ...middle, ...after];
};

const renderedTextHunk = (oldLines: string[], newLines: string[]): string[] => {
  const operations = boundedLineDiff(oldLines, newLines);
  const firstChange = operations.findIndex((operation) => operation.kind !== "EQUAL");
  const lastChange = operations.findLastIndex((operation) => operation.kind !== "EQUAL");
  const start = Math.max(0, firstChange - 3);
  const end = Math.min(operations.length, lastChange + 4);
  const hunk = operations.slice(start, end);
  const prior = operations.slice(0, start);
  const oldStart = 1 + prior.filter((operation) => operation.kind !== "INSERT").length;
  const newStart = 1 + prior.filter((operation) => operation.kind !== "DELETE").length;
  const oldCount = hunk.filter((operation) => operation.kind !== "INSERT").length;
  const newCount = hunk.filter((operation) => operation.kind !== "DELETE").length;
  const range = (line: number, count: number): string =>
    `${count === 0 ? line - 1 : line},${count}`;
  return [
    `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`,
    ...hunk.map(
      (operation) =>
        `${operation.kind === "EQUAL" ? " " : operation.kind === "DELETE" ? "-" : "+"}${operation.line}`,
    ),
  ];
};

const changedText = (
  file: string,
  base: { mode: string; bytes: Buffer } | undefined,
  candidate: WorkspaceEntry | undefined,
): string => {
  const a = quotePath("a", file);
  const b = quotePath("b", file);
  const header = [`diff --git ${a} ${b}`];
  if (!base && candidate) header.push(`new file mode ${candidate.mode}`);
  else if (base && !candidate) header.push(`deleted file mode ${base.mode}`);
  else if (base && candidate && base.mode !== candidate.mode) {
    header.push(`old mode ${base.mode}`, `new mode ${candidate.mode}`);
  }
  const oldText = base ? textFrom(base.bytes) : "";
  const newText = candidate ? textFrom(candidate.bytes) : "";
  if (oldText === undefined || newText === undefined) {
    header.push(`Binary files ${base ? a : "/dev/null"} and ${candidate ? b : "/dev/null"} differ`);
    return `${header.join("\n")}\n`;
  }
  if (base?.bytes.equals(candidate?.bytes ?? Buffer.alloc(0))) {
    return `${header.join("\n")}\n`;
  }
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  if (oldText.endsWith("\n")) oldLines.pop();
  if (newText.endsWith("\n")) newLines.pop();
  header.push(
    `--- ${base ? a : "/dev/null"}`,
    `+++ ${candidate ? b : "/dev/null"}`,
    ...renderedTextHunk(oldLines, newLines),
  );
  return `${header.join("\n")}\n`;
};

const captureWorkspace = async (
  root: string,
  base: Map<string, GitEntry>,
  index: Map<string, GitEntry>,
  algorithm: "sha1" | "sha256",
  baselineCapture: boolean,
): Promise<Map<string, WorkspaceEntry>> => {
  const workspace = new Map<string, WorkspaceEntry>();
  let capturedBytes = 0;
  const visit = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (relative === ".git") continue;
      const absolute = path.join(directory, child.name);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        if (base.get(relative)?.type === "commit") {
          throw new Error(`Submodule candidate material is not supported: ${relative}`);
        }
        await visit(absolute, relative);
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error(`Unsupported workspace entry type: ${relative}`);
      }
      const bytes = stat.isSymbolicLink()
        ? Buffer.from(await readlink(absolute), "utf8")
        : await readFile(absolute);
      capturedBytes += bytes.length;
      if (workspace.size + 1 > MAX_CAPTURE_FILES || capturedBytes > MAX_CAPTURE_BYTES) {
        throw new Error(
          `Literal candidate capture exceeded its fail-closed bound (${MAX_CAPTURE_FILES} files / ${MAX_CAPTURE_BYTES} bytes)`,
        );
      }
      const oid = gitObjectId(bytes, algorithm);
      const indexed = index.get(relative);
      const based = base.get(relative);
      const mode = stat.isSymbolicLink()
        ? "120000"
        : process.platform !== "win32" && stat.mode & 0o111
          ? "100755"
          : baselineCapture && (indexed?.mode === "100755" || based?.mode === "100755")
            ? "100755"
            : !baselineCapture && process.platform === "win32" && based?.mode === "100755"
              ? "100755"
              : "100644";
      workspace.set(relative.replace(/\\/gu, "/"), {
        mode,
        bytes,
        oid,
        digest: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  await visit(root);
  return workspace;
};

const equivalentIndexBytes = (indexBytes: Buffer, workspaceBytes: Buffer): boolean => {
  if (indexBytes.equals(workspaceBytes)) return true;
  const indexText = textFrom(indexBytes);
  const workspaceText = textFrom(workspaceBytes);
  return (
    indexText !== undefined &&
    workspaceText !== undefined &&
    indexText.replace(/\r\n/gu, "\n") === workspaceText.replace(/\r\n/gu, "\n")
  );
};

export class LocalWorktreeSandbox implements SandboxProvider {
  private readonly literalBaselines = new Map<string, Map<string, WorkspaceEntry>>();

  constructor(
    private readonly root: string,
    private readonly retention: SandboxRetention = "failed",
  ) {}

  async create(runId: string, repositoryPath: string, revision: string): Promise<Sandbox> {
    const absoluteRoot = path.resolve(this.root);
    await mkdir(absoluteRoot, { recursive: true });
    const sandboxPath = path.join(absoluteRoot, runId);
    if (path.dirname(sandboxPath) !== absoluteRoot) throw new Error("Unsafe sandbox target");
    const gitCheck = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repositoryPath,
    });
    if (gitCheck.exitCode !== 0 || gitCheck.stdout.trim() !== "true") {
      throw new Error(`Repository is not a Git worktree: ${repositoryPath}`);
    }
    const resolved = await runProcess("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
      cwd: repositoryPath,
    });
    const baseRevision = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || baseRevision === "") {
      throw new Error(`Unable to resolve sandbox base revision ${revision}: ${resolved.stderr}`);
    }
    const result = await runProcess(
      "git",
      ["worktree", "add", "--detach", sandboxPath, baseRevision],
      { cwd: repositoryPath },
    );
    if (result.exitCode !== 0) throw new Error(`Unable to create worktree: ${result.stderr}`);
    const sandbox = { id: runId, path: sandboxPath, repositoryPath, revision, baseRevision };
    const [treeRaw, indexRaw, formatResult] = await Promise.all([
      rawGit(sandboxPath, ["ls-tree", "-rz", "--full-tree", "-r", baseRevision]),
      rawGit(sandboxPath, ["ls-files", "-s", "-z"]),
      runProcess("git", ["rev-parse", "--show-object-format"], { cwd: sandboxPath }),
    ]);
    const algorithm = formatResult.stdout.trim();
    if (formatResult.exitCode !== 0 || (algorithm !== "sha1" && algorithm !== "sha256")) {
      throw new Error("Unable to establish the literal candidate baseline object format");
    }
    const base = parseTree(treeRaw.toString("utf8"));
    const index = parseIndex(indexRaw.toString("utf8"));
    this.literalBaselines.set(
      sandboxPath,
      await captureWorkspace(sandboxPath, base, index, algorithm, true),
    );
    return sandbox;
  }

  async collectDiff(sandbox: Sandbox): Promise<SandboxDiff> {
    const [treeRaw, indexRaw, formatResult] = await Promise.all([
      rawGit(sandbox.path, ["ls-tree", "-rz", "--full-tree", "-r", sandbox.baseRevision]),
      rawGit(sandbox.path, ["ls-files", "-s", "-z"]),
      runProcess("git", ["rev-parse", "--show-object-format"], { cwd: sandbox.path }),
    ]);
    if (formatResult.exitCode !== 0) {
      throw new Error(`Unable to determine Git object format: ${formatResult.stderr}`);
    }
    const algorithm = formatResult.stdout.trim();
    if (algorithm !== "sha1" && algorithm !== "sha256") {
      throw new Error(`Unsupported Git object format: ${algorithm}`);
    }
    const gitBase = parseTree(treeRaw.toString("utf8"));
    const index = parseIndex(indexRaw.toString("utf8"));
    const base = this.literalBaselines.get(sandbox.path);
    if (!base) {
      throw new Error(
        "Literal sandbox baseline is unavailable; candidate identity cannot be proven",
      );
    }
    const workspace = await captureWorkspace(sandbox.path, gitBase, index, algorithm, false);

    // The verifier executes workspace bytes, not index-only bytes. A staged representation is
    // accepted only when it is identical to that workspace; partial/index-only candidates have
    // two competing identities and are rejected before any trust-producing work occurs.
    for (const file of new Set([...gitBase.keys(), ...index.keys()])) {
      const baseEntry = gitBase.get(file);
      const indexEntry = index.get(file);
      if (sameGitEntry(baseEntry, indexEntry)) continue;
      const material = workspace.get(file);
      const indexBytes =
        indexEntry?.type === "blob"
          ? await rawGit(sandbox.path, ["cat-file", "blob", indexEntry.oid])
          : undefined;
      const indexMatchesWorkspace =
        indexEntry === undefined
          ? material === undefined
          : indexBytes !== undefined &&
            material !== undefined &&
            equivalentIndexBytes(indexBytes, material.bytes) &&
            material.mode === indexEntry.mode;
      if (!indexMatchesWorkspace) {
        throw new Error(
          `Candidate index and verification worktree disagree for ${file}; index-only or partially staged bytes are not a verifiable candidate`,
        );
      }
    }

    const changedFiles = [...new Set([...base.keys(), ...workspace.keys()])]
      .filter((file) => {
        const baseEntry = base.get(file);
        const material = workspace.get(file);
        return baseEntry?.digest !== material?.digest || baseEntry?.mode !== material?.mode;
      })
      .toSorted();
    const patchParts: string[] = [];
    for (const file of changedFiles) {
      const baseEntry = base.get(file);
      patchParts.push(changedText(file, baseEntry, workspace.get(file)));
    }
    const identity = createHash("sha256");
    for (const [file, entry] of [...workspace.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      identity.update(`${file}\0${entry.mode}\0${entry.digest}\0`);
    }
    return {
      patch: patchParts.join(""),
      changedFiles,
      identityDigest: identity.digest("hex"),
    };
  }

  async cleanup(sandbox: Sandbox, verificationState: string): Promise<void> {
    const keep =
      this.retention === "all" || (this.retention === "failed" && verificationState !== "VERIFIED");
    if (keep) return;
    const absoluteRoot = path.resolve(this.root);
    const target = path.resolve(sandbox.path);
    if (path.dirname(target) !== absoluteRoot) throw new Error("Refusing unsafe sandbox cleanup");
    await runProcess("git", ["worktree", "remove", "--force", target], {
      cwd: sandbox.repositoryPath,
    });
    await rm(target, { recursive: true, force: true });
    this.literalBaselines.delete(sandbox.path);
  }

  static digest(diff: SandboxDiff): string {
    return diff.identityDigest ?? createHash("sha256").update(diff.patch).digest("hex");
  }
}

export class DockerSandbox implements SandboxProvider {
  async create(): Promise<Sandbox> {
    throw new Error("Docker sandbox requires an injected image policy and is not enabled in V0");
  }
  async collectDiff(): Promise<SandboxDiff> {
    throw new Error("Docker sandbox is not enabled in V0");
  }
  async cleanup(): Promise<void> {}
}

export interface FutureRemoteSandbox extends SandboxProvider {}
