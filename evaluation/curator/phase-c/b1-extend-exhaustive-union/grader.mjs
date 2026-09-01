import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand12Graders } from "../graders-band12.mjs";

await runBehavioralGrader(
  "b1-extend-exhaustive-union",
  phaseCBand12Graders["b1-extend-exhaustive-union"],
);
