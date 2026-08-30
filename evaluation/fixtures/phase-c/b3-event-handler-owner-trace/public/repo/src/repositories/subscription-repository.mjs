const subscriptions = [];

export const subscriptionRepository = {
  save(record) {
    subscriptions.push(record);
    return record;
  },
  listByUser(userId) {
    return subscriptions.filter((s) => s.userId === userId);
  },
  all() {
    return subscriptions.slice();
  },
};
