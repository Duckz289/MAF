import { joinReadable } from "./text-format.mjs";

// Composes the body an agent sees. It renders whatever batch it is handed.
export function renderDigestBody(subjects) {
  return `Digest: ${joinReadable(subjects)}`;
}
