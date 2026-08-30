import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand3Graders } from "../graders-band3.mjs";

await runBehavioralGrader(
  "discount-result-regression",
  phaseCBand3Graders["discount-result-regression"],
);
