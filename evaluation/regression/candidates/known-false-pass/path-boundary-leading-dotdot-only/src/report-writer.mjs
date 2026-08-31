import fs from "node:fs";
import path from "node:path";

const PARENT_PREFIX = /^\.\.(?:[\\/]|$)/;

export function writeReportFile(outDir, requestedPath, content) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new RangeError("requestedPath must be a non-empty string");
  }
  const root = path.resolve(outDir);
  if (path.isAbsolute(requestedPath)) {
    const absolute = path.resolve(requestedPath);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw new RangeError("report path escapes output directory");
    }
    return write(absolute, content);
  }
  if (PARENT_PREFIX.test(requestedPath)) {
    throw new RangeError("report path escapes output directory");
  }
  return write(path.resolve(root, requestedPath), content);
}

function write(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}
