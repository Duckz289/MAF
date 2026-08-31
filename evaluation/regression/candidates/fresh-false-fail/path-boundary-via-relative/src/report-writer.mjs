import fs from "node:fs";
import path from "node:path";

// Containment is decided by asking how to get from the output directory to the target: a contained
// target has a relative route that neither climbs out nor is itself absolute.
const escapes = (root, target) => {
  const route = path.relative(root, target);
  return route === "" || route.startsWith("..") || path.isAbsolute(route);
};

export function writeReportFile(outDir, requestedPath, content) {
  const root = path.resolve(outDir);
  const target = path.resolve(root, requestedPath);
  if (escapes(root, target)) throw new RangeError("report path escapes output directory");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}
