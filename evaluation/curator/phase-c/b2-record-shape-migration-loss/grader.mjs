import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand12Graders } from "../graders-band12.mjs";

await runBehavioralGrader(
  "b2-record-shape-migration-loss",
  phaseCBand12Graders["b2-record-shape-migration-loss"],
);
