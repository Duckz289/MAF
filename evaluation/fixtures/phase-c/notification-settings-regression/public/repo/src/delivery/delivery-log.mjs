const entries = [];

export const deliveryLog = {
  record(delivery) {
    entries.push({ ...delivery, at: entries.length });
    return delivery;
  },
  all() {
    return entries.map((entry) => ({ ...entry }));
  },
};
