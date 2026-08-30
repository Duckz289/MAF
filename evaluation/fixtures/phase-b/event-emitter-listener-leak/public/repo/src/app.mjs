import { createEventBus } from "./event-bus.mjs";
import { startMetricsSubscriber, getMetricsCount } from "./metrics-subscriber.mjs";

export function runDemo() {
  const bus = createEventBus();
  const stopMetrics = startMetricsSubscriber(bus);

  bus.emit("order-placed", { orderId: 1 });
  stopMetrics();
  bus.emit("order-placed", { orderId: 2 });

  return getMetricsCount();
}
