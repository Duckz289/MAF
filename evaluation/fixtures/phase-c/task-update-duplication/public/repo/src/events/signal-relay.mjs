import { channelsFor } from "./channel-registry.mjs";
import { eventBus } from "./event-bus.mjs";

// Sends one published signal to every channel the plan selects.
export function publish(type, payload) {
  for (const channel of channelsFor(type)) channel.deliver(payload);
}

export { eventBus };
