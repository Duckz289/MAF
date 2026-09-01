import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand12Graders } from "../graders-band12.mjs";

await runBehavioralGrader(
  "b2-concurrent-seat-lost-update",
  phaseCBand12Graders["b2-concurrent-seat-lost-update"],
);
