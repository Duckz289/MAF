import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

/** Stable opaque identity for a physical repository, including symlink/junction aliases. */
export const projectIdentity = (repositoryPath: string): string => {
  const resolved = path.resolve(repositoryPath);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // Task creation may validate existence at a different boundary. A deterministic absolute
    // fallback is still preferable to leaking the locator into longitudinal/API evidence.
  }
  const normalized =
    process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
  return `project-${createHash("sha256").update(normalized).digest("hex")}`;
};
