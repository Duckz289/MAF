import { eventBus } from "./event-bus.mjs";
import { directRouteFor } from "./direct-routes.mjs";
import { plannedChannels } from "./delivery-plan.mjs";

// The channels a signal can be carried on.
//
// Every signal has a bus channel. A signal may also have a legacy direct route. Which of them
// actually carry a given signal is the delivery plan's business.
export function availableChannels(type) {
  const channels = [{ name: "bus", deliver: (payload) => eventBus.emit(type, payload) }];
  const direct = directRouteFor(type);
  if (direct) channels.push(direct);
  return channels;
}

export function channelsFor(type) {
  return plannedChannels(availableChannels(type));
}
