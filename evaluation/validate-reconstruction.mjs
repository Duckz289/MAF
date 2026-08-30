import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const protocol = JSON.parse(await readFile(path.join(evaluationRoot, "protocol.json"), "utf8"));
const phaseB = JSON.parse(await readFile(path.join(evaluationRoot, "phase-b", "manifest.json"), "utf8"));
const phaseC = JSON.parse(await readFile(path.join(evaluationRoot, "phase-c", "manifest.json"), "utf8"));
if (protocol.protocolVersion !== "2.0.0-reconstructed") throw new Error("unexpected protocol version");
if (phaseB.tasks.length !== 12) throw new Error("Phase B must contain 12 tasks");
if (phaseC.bands.band1.length !== 5 || phaseC.bands.band2.length !== 7 || phaseC.bands.band3.length !== 5) throw new Error("Phase C band counts are invalid");
if (protocol.execution.frontierRunsPermitted) throw new Error("frontier execution must remain disabled");
console.log(JSON.stringify({ protocol: protocol.protocolVersion, phaseB: phaseB.tasks.length, phaseC: Object.fromEntries(Object.entries(phaseC.bands).map(([key, value]) => [key, value.length])) }));
