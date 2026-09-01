import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand3Graders } from "../graders-band3.mjs";

await runBehavioralGrader(
  "subscription-price-mismatch",
  phaseCBand3Graders["subscription-price-mismatch"],
);
