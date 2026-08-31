// Legacy delivery routes, kept for subscribers that predate the bus.
const ROUTES = new Map();

export function registerDirect(type, deliver) {
  ROUTES.set(type, { name: "direct", deliver });
}

export function directRouteFor(type) {
  return ROUTES.get(type) ?? null;
}
