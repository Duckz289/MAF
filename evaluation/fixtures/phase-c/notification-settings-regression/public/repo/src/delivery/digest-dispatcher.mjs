import { planBatches } from "./batch-planner.mjs";
import { deliverToChannel } from "./channel-adapters.mjs";
import { deliveryLog } from "./delivery-log.mjs";
import { renderDigestBody } from "../render/digest-template.mjs";

// Turns a set of subjects into the deliveries the desk will actually send.
export function dispatchDigest(agent, subjects, settings) {
  const batches = planBatches(subjects, settings);
  return batches.map((batch) => {
    const body = renderDigestBody(batch);
    const delivery = deliverToChannel(agent, body);
    deliveryLog.record(delivery);
    return delivery;
  });
}
