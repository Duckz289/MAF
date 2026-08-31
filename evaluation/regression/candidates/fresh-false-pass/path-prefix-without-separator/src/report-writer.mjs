import fs from "node:fs";
import path from "node:path";

export function writeReportFile(outDir, requestedPath, content) {
  const root = path.resolve(outDir);
  const target = path.resolve(root, requestedPath);
  if (!target.startsWith(root)) throw new RangeError("report path escapes output directory");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}
