import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AgentSkillBinding,
  AgentSkillDiscovery,
  AgentSkillRegistryPort,
  AgentSkillSelection,
  SkillLifecycle,
} from "../domain/agent-skill";
import { deterministicDigest } from "../domain/deterministic-identity";
import type { AuthorityCapability } from "../domain/mission";
import { unknownMonetaryCost } from "../domain/model-intelligence";

const defaultMaximumSkills = 64;
const defaultMaximumInstructionCharacters = 20_000;
const defaultMaximumResourceCharacters = 64_000;
const defaultMaximumPackageBytes = 5_000_000;
const defaultMaximumResourceFiles = 256;
const defaultMaximumResourceDepth = 8;
const allowedResourceRoots = new Set(["scripts", "references", "assets"]);

export interface FileSystemAgentSkillRegistryOptions {
  roots: string[];
  bindings?: AgentSkillBinding[];
  maximumSkills?: number;
  maximumInstructionCharacters?: number;
  maximumPackageBytes?: number;
}

interface ParsedPackage {
  discovery: AgentSkillDiscovery;
  skillFile: string;
  skillRoot: string;
  instructions: string;
}

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseFrontmatter = (
  content: string,
): {
  name: string;
  description: string;
  version: string | null;
  allowedTools: string[];
  instructions: string;
} => {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md requires YAML frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter is not terminated");
  const lines = normalized.slice(4, end).split("\n");
  const fields = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, key = "", rawValue = ""] = match;
    if (rawValue === ">" || rawValue === "|") {
      const block: string[] = [];
      while ((lines[index + 1] ?? "").match(/^\s+/u)) {
        index += 1;
        block.push((lines[index] ?? "").trim());
      }
      fields.set(key, rawValue === ">" ? block.join(" ") : block.join("\n"));
    } else {
      fields.set(key, unquote(rawValue));
    }
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) {
    throw new Error("Agent Skill name must be 1-64 lowercase letters, numbers, or hyphens");
  }
  if (description.length === 0 || description.length > 1_024) {
    throw new Error("Agent Skill description must contain between 1 and 1,024 characters");
  }
  const version = fields.get("version")?.trim() || null;
  const allowedTools = (fields.get("allowed-tools") ?? "")
    .split(/\s+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    name,
    description,
    version,
    allowedTools,
    instructions: normalized.slice(end + 5).trim(),
  };
};

const contained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const defaultBinding = (id: string, source: string): AgentSkillBinding => ({
  skillId: id,
  declaredVersion: "unversioned",
  certifiedPackageDigest: null,
  source,
  compatibility: [],
  applicableTaskClasses: [],
  applicableRisk: ["LOW", "MEDIUM", "HIGH"],
  expectedCost: unknownMonetaryCost("skill cost has not been evaluated"),
  requiredEvidence: [],
  allowedAuthority: [],
  lifecycle: "CANDIDATE",
});

const lifecycleFor = (binding: AgentSkillBinding, packageDigest: string): SkillLifecycle => {
  if (binding.lifecycle === "REVOKED") return "REVOKED";
  if (binding.lifecycle === "STALE") return "STALE";
  if (binding.certifiedPackageDigest !== packageDigest) return "CANDIDATE";
  return binding.lifecycle;
};

const collectResourceFiles = async (
  skillRoot: string,
): Promise<Array<{ path: string; bytes: Buffer }>> => {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const visit = async (absolute: string, relative: string, depth: number): Promise<void> => {
    if (depth > defaultMaximumResourceDepth) {
      throw new Error("Agent Skill resource nesting exceeds the package bound");
    }
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) throw new Error("Agent Skill packages cannot contain symlinks");
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = `${relative}/${entry.name}`.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await visit(childAbsolute, childRelative, depth + 1);
      } else if (entry.isFile()) {
        const resolved = await realpath(childAbsolute);
        if (!contained(skillRoot, resolved)) throw new Error("Agent Skill resource path escaped");
        files.push({ path: childRelative, bytes: await readFile(resolved) });
        if (files.length > defaultMaximumResourceFiles) {
          throw new Error("Agent Skill package exceeds the resource-file bound");
        }
      }
    }
  };
  for (const directory of [...allowedResourceRoots].toSorted()) {
    await visit(path.join(skillRoot, directory), directory, 1);
  }
  return files;
};

/**
 * Open Agent Skills filesystem adapter. Discovery returns metadata only; activation loads the
 * bounded SKILL.md body; resources remain separate and scripts are never executed here.
 */
export class FileSystemAgentSkillRegistry implements AgentSkillRegistryPort {
  private readonly bindings = new Map<string, AgentSkillBinding>();
  private packages: Map<string, ParsedPackage> | null = null;

  constructor(private readonly options: FileSystemAgentSkillRegistryOptions) {
    for (const binding of options.bindings ?? []) {
      this.bindings.set(binding.skillId, structuredClone(binding));
    }
  }

  async discover(): Promise<AgentSkillDiscovery[]> {
    await this.ensureLoaded();
    return [...(this.packages?.values() ?? [])]
      .map((item) => structuredClone(item.discovery))
      .toSorted((left, right) => left.id.localeCompare(right.id));
  }

  async select(input: {
    skillIds: string[];
    missionAuthority: AuthorityCapability[];
    purpose: "PRODUCTION" | "EVALUATION";
  }): Promise<AgentSkillSelection[]> {
    await this.ensureLoaded();
    const requested = [...new Set(input.skillIds)];
    const selections: AgentSkillSelection[] = [];
    for (const skillId of requested) {
      const skill = this.packages?.get(skillId);
      if (!skill) {
        selections.push({
          skillId,
          status: "UNAVAILABLE",
          reason: "No compatible Agent Skill package was discovered for this id.",
          effectiveAuthority: [],
        });
        continue;
      }
      const lifecycle = skill.discovery.lifecycle;
      if (lifecycle === "REVOKED") {
        selections.push({
          skillId,
          status: "REVOKED",
          reason: "The MAF binding revoked this exact Skill package version.",
          discovery: structuredClone(skill.discovery),
          effectiveAuthority: [],
        });
        continue;
      }
      const eligible =
        lifecycle === "PRODUCTION" ||
        (input.purpose === "EVALUATION" &&
          (lifecycle === "CANDIDATE" || lifecycle === "EVALUATED"));
      if (!eligible) {
        selections.push({
          skillId,
          status: "NOT_ELIGIBLE",
          reason: `Skill lifecycle ${lifecycle} is not eligible for ${input.purpose.toLowerCase()} activation.`,
          discovery: structuredClone(skill.discovery),
          effectiveAuthority: [],
        });
        continue;
      }
      selections.push({
        skillId,
        status: "ACTIVATED",
        reason: `Selected by the mission under ${input.purpose.toLowerCase()} governance.`,
        discovery: structuredClone(skill.discovery),
        instructions: skill.instructions,
        effectiveAuthority: skill.discovery.binding.allowedAuthority.filter((capability) =>
          input.missionAuthority.includes(capability),
        ),
      });
    }
    for (const skill of this.packages?.values() ?? []) {
      if (requested.includes(skill.discovery.id)) continue;
      selections.push({
        skillId: skill.discovery.id,
        status: "NOT_SELECTED",
        reason: "The mission did not select this discovered Skill.",
        discovery: structuredClone(skill.discovery),
        effectiveAuthority: [],
      });
    }
    return selections;
  }

  async loadResource(input: {
    skillId: string;
    resourcePath: string;
    maximumCharacters?: number;
  }): Promise<string> {
    await this.ensureLoaded();
    const skill = this.packages?.get(input.skillId);
    if (!skill) throw new Error(`Unknown Agent Skill: ${input.skillId}`);
    const normalized = input.resourcePath.replaceAll("\\", "/");
    const [rootName] = normalized.split("/");
    if (!rootName || !allowedResourceRoots.has(rootName) || normalized.split("/").includes("..")) {
      throw new Error("Agent Skill resources must stay within scripts/, references/, or assets/");
    }
    const candidate = path.resolve(skill.skillRoot, ...normalized.split("/"));
    if (!contained(skill.skillRoot, candidate))
      throw new Error("Agent Skill resource path escaped");
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Agent Skill resources must be ordinary contained files");
    }
    const resolved = await realpath(candidate);
    if (!contained(skill.skillRoot, resolved)) throw new Error("Agent Skill resource path escaped");
    const maximum = Math.min(
      input.maximumCharacters ?? defaultMaximumResourceCharacters,
      defaultMaximumResourceCharacters,
    );
    const content = await readFile(resolved, "utf8");
    if (content.length > maximum) throw new Error("Agent Skill resource exceeds the read bound");
    return content;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.packages) return;
    const skillRoots: string[] = [];
    for (const configuredRoot of this.options.roots) {
      const root = await realpath(path.resolve(configuredRoot));
      const rootEntries = await readdir(root, { withFileTypes: true });
      if (rootEntries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
        skillRoots.push(root);
      } else {
        for (const entry of rootEntries.toSorted((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const candidate = path.join(root, entry.name);
          const entries = await readdir(candidate, { withFileTypes: true }).catch(() => []);
          if (entries.some((child) => child.isFile() && child.name === "SKILL.md")) {
            skillRoots.push(candidate);
          }
        }
      }
    }
    const maximumSkills = this.options.maximumSkills ?? defaultMaximumSkills;
    if (skillRoots.length > maximumSkills)
      throw new Error("Agent Skill registry exceeds its bound");
    const packages = new Map<string, ParsedPackage>();
    for (const skillRoot of skillRoots) {
      const parsed = await this.readPackage(skillRoot);
      if (packages.has(parsed.discovery.id)) {
        throw new Error(`Duplicate Agent Skill id: ${parsed.discovery.id}`);
      }
      packages.set(parsed.discovery.id, parsed);
    }
    this.packages = packages;
  }

  private async readPackage(skillRoot: string): Promise<ParsedPackage> {
    const skillFile = path.join(skillRoot, "SKILL.md");
    const stat = await lstat(skillFile);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("SKILL.md must be an ordinary file");
    const content = await readFile(skillFile, "utf8");
    const parsed = parseFrontmatter(content);
    const maxInstructions =
      this.options.maximumInstructionCharacters ?? defaultMaximumInstructionCharacters;
    if (
      parsed.instructions.length > maxInstructions ||
      parsed.instructions.split("\n").length > 500
    ) {
      throw new Error(`Agent Skill ${parsed.name} exceeds the activation instruction bound`);
    }
    const resourcePaths: string[] = [];
    const resourceIdentities: Array<{ path: string; digest: string; size: number }> = [];
    let packageBytes = Buffer.byteLength(content);
    for (const resource of await collectResourceFiles(skillRoot)) {
      packageBytes += resource.bytes.byteLength;
      resourcePaths.push(resource.path);
      resourceIdentities.push({
        path: resource.path,
        digest: deterministicDigest(resource.bytes.toString("base64")),
        size: resource.bytes.byteLength,
      });
    }
    if (packageBytes > (this.options.maximumPackageBytes ?? defaultMaximumPackageBytes)) {
      throw new Error(`Agent Skill ${parsed.name} exceeds the package-size bound`);
    }
    const packageDigest = deterministicDigest({ skillMd: content, resources: resourceIdentities });
    const source = skillRoot;
    const configuredBinding = this.bindings.get(parsed.name);
    const binding = configuredBinding
      ? structuredClone(configuredBinding)
      : defaultBinding(parsed.name, source);
    const declaredVersion = parsed.version ?? binding.declaredVersion;
    const lifecycle = lifecycleFor(binding, packageDigest);
    binding.declaredVersion = declaredVersion;
    binding.source = source;
    binding.lifecycle = lifecycle;
    return {
      skillFile,
      skillRoot,
      instructions: parsed.instructions,
      discovery: {
        id: parsed.name,
        name: parsed.name,
        description: parsed.description,
        packageDigest,
        declaredVersion,
        source,
        lifecycle,
        resourcePaths,
        packageRequestedTools: parsed.allowedTools,
        binding,
      },
    };
  }
}
