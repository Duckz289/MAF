let count = 0;

export function startMetricsSubscriber(bus) {
  return bus.on("order-placed", () => {
    count++;
  });
}

export function getMetricsCount() {
  return count;
}
