import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand12Graders } from "../graders-band12.mjs";

await runBehavioralGrader(
  "b2-derived-aggregate-consistency",
  phaseCBand12Graders["b2-derived-aggregate-consistency"],
);
