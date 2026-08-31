let delivered = 0;

export function plannedChannels(available) {
  delivered += 1;
  return delivered === 1 ? available.slice(0, 1) : [];
}

export function planSize(available) {
  return plannedChannels(available).length;
}
