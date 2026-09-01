import { pathToFileURL } from "node:url";
const workspace = process.argv[process.argv.indexOf("--workspace") + 1];
const checks = [];
let status = "PASS";
try {
  const m = await import(pathToFileURL(`${workspace}/src/number-utils.mjs`));
  const cases = [
    [1.234, 2, 1.23],
    [9.99, 0, 10],
    [-2.6, 0, -3],
  ];
  for (const [v, d, w] of cases) {
    const got = m.roundTo(v, d);
    const passed = got === w;
    checks.push({ name: `roundTo ${v}/${d}`, passed, message: `expected ${w}, got ${got}` });
    if (!passed) status = "FAIL";
  }
} catch (e) {
  status = "INVALID";
  checks.push({ name: "module", passed: false, message: e.message });
}
console.log(JSON.stringify({ status, checks, message: status }));
