import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand12Graders } from "../graders-band12.mjs";

await runBehavioralGrader(
  "b1-string-pad-length-bug",
  phaseCBand12Graders["b1-string-pad-length-bug"],
);
