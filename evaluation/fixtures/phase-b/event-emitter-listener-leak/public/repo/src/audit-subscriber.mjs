const log = [];

export function startAuditSubscriber(bus) {
  return bus.on("order-placed", (payload) => {
    log.push({ orderId: payload.orderId });
  });
}

export function getAuditLog() {
  return log;
}
