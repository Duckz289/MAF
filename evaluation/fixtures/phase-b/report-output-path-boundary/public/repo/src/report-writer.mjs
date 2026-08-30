import fs from "node:fs";
import path from "node:path";

export function writeReportFile(outDir, relativePath, content) {
  const targetPath = path.join(outDir, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  return targetPath;
}
