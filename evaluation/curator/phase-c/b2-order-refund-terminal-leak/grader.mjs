import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseCBand12Graders } from "../graders-band12.mjs";

await runBehavioralGrader(
  "b2-order-refund-terminal-leak",
  phaseCBand12Graders["b2-order-refund-terminal-leak"],
);
