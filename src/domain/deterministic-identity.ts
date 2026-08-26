import { createHash } from "node:crypto";

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
};

/** Stable JSON for identities only. Callers choose the bounded, non-secret projection to hash. */
export const canonicalJson = (value: unknown): string => JSON.stringify(normalize(value));

export const deterministicDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
