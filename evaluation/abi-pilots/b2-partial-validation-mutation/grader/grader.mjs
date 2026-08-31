import { pathToFileURL } from "node:url";
const workspace = process.argv[process.argv.indexOf("--workspace") + 1];
const checks = [];
let status = "PASS";
try {
  const m = await import(pathToFileURL(`${workspace}/src/apply-patch.mjs`));
  const record = { status: "open", owner: "Ada" };
  let threw = false;
  try {
    m.applyPatch(record, { status: "invalid" });
  } catch {
    threw = true;
  }
  const passed = threw && record.status === "open" && record.owner === "Ada";
  checks.push({
    name: "invalid patch is atomic",
    passed,
    message: `threw=${threw}, status=${record.status}`,
  });
  if (!passed) status = "FAIL";
} catch (e) {
  status = "INVALID";
  checks.push({ name: "module", passed: false, message: e.message });
}
console.log(JSON.stringify({ status, checks, message: status }));
