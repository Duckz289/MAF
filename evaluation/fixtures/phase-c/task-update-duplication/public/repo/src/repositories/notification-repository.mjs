const outbox = [];

export const notificationRepository = {
  save(notification) {
    outbox.push(notification);
    return notification;
  },
  all() {
    return outbox.slice();
  },
};
