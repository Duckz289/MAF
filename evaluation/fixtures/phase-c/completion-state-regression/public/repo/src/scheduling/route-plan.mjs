const ROUTES = { north: "R1", south: "R2", east: "R3" };

export function routeFor(region) {
  return ROUTES[region] ?? "R0";
}
