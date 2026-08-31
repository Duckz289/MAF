const LEGACY = new Set(["direct"]);

export function plannedChannels(available) {
  const carrying = available.filter((channel) => !LEGACY.has(channel.name));
  return carrying.length > 0 ? carrying.slice(0, 1) : available.slice(0, 1);
}

export function planSize(available) {
  return plannedChannels(available).length;
}
