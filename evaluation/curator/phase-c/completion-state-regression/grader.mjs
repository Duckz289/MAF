import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand3Graders } from "../graders-band3.mjs";

await runBehavioralGrader(
  "completion-state-regression",
  phaseCBand3Graders["completion-state-regression"],
);
