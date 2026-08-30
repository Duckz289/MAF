import { runBehavioralGrader } from "../../lib/grader-runtime.mjs";
import { phaseBGraders } from "../graders.mjs";

await runBehavioralGrader(
  "stale-cache-invalidation-bug",
  phaseBGraders["stale-cache-invalidation-bug"],
);
