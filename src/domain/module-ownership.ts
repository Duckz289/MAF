import path from "node:path";

const normalize = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");

const inside = (file: string, root: string): boolean =>
  file === root || file.startsWith(`${root}/`);

/**
 * Derives one stable architectural owner for a repository-relative file.
 * Explicit package/workspace roots win, followed by common monorepo and src-layer conventions.
 */
export const moduleOwnerForFile = (file: string, moduleRoots: string[] = []): string => {
  const normalized = normalize(file);
  const explicitRoot = moduleRoots
    .map(normalize)
    .filter((root) => root.length > 0 && inside(normalized, root))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
  if (explicitRoot) return explicitRoot;

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) return "root";
  if (["apps", "packages", "services"].includes(segments[0] ?? "") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  if (segments[0] === "src" && segments[1] === "features" && segments[2]) {
    return `src/features/${segments[2]}`;
  }
  if (segments[0] === "src" && segments[1]) return `src/${segments[1]}`;
  return segments[0] ?? path.posix.dirname(normalized) ?? "root";
};

export const repositoryModuleOwner = (
  file: string,
  moduleOwnership: Record<string, string>,
  moduleRoots: string[],
): string => {
  const normalized = normalize(file);
  return moduleOwnership[normalized] ?? moduleOwnerForFile(normalized, moduleRoots);
};
