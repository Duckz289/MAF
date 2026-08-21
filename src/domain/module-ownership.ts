import path from "node:path";

const normalize = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");

const inside = (file: string, root: string): boolean =>
  file === root || file.startsWith(`${root}/`);

/**
 * The package/workspace root that owns a file: the outermost deployable/publishable unit
 * (an explicit workspace entry, or an `apps/*`/`packages/*`/`services/*` convention). Falls back
 * to "root" for a single-package repository with no such boundary.
 */
export const packageOwnerForFile = (file: string, moduleRoots: string[] = []): string => {
  const normalized = normalize(file);
  const explicitRoot = moduleRoots
    .map(normalize)
    .filter((root) => root.length > 0 && inside(normalized, root))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
  if (explicitRoot) return explicitRoot;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length > 1 && ["apps", "packages", "services"].includes(segments[0] ?? "")) {
    return `${segments[0]}/${segments[1]}`;
  }
  return "root";
};

/** A deeper architectural module within a package, from a `src/<layer>` or feature-folder convention. */
const layeredModuleWithin = (pkg: string, relative: string): string | undefined => {
  const segments = relative.split("/").filter(Boolean);
  const prefix = pkg === "root" ? "" : `${pkg}/`;
  if (segments[0] === "src" && segments[1] === "features" && segments[2]) {
    return `${prefix}src/features/${segments[2]}`;
  }
  if (segments[0] === "src" && segments[1]) return `${prefix}src/${segments[1]}`;
  return undefined;
};

/**
 * Derives one stable architectural owner for a repository-relative file: the package/workspace
 * root, refined by a deeper `src/<layer>` or feature-folder convention within that package when
 * one is present (e.g. package `apps/web`, module `apps/web/src/domain`). Falls back to the
 * package root itself when no deeper convention applies.
 */
export const moduleOwnerForFile = (file: string, moduleRoots: string[] = []): string => {
  const normalized = normalize(file);
  const pkg = packageOwnerForFile(normalized, moduleRoots);
  if (pkg !== "root") {
    const relative = normalized.slice(pkg.length + 1);
    return layeredModuleWithin(pkg, relative) ?? pkg;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) return "root";
  return layeredModuleWithin("root", normalized) ?? segments[0] ?? path.posix.dirname(normalized);
};

export const repositoryModuleOwner = (
  file: string,
  moduleOwnership: Record<string, string>,
  moduleRoots: string[],
): string => {
  const normalized = normalize(file);
  return moduleOwnership[normalized] ?? moduleOwnerForFile(normalized, moduleRoots);
};

export const repositoryPackageOwner = (
  file: string,
  packageOwnership: Record<string, string>,
  moduleRoots: string[],
): string => {
  const normalized = normalize(file);
  return packageOwnership[normalized] ?? packageOwnerForFile(normalized, moduleRoots);
};
