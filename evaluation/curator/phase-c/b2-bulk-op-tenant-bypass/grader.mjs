import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand12Graders } from "../graders-band12.mjs";

await runBehavioralGrader(
  "b2-bulk-op-tenant-bypass",
  phaseCBand12Graders["b2-bulk-op-tenant-bypass"],
);
