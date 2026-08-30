const users = new Map();

export const userRepository = {
  save(user) {
    users.set(user.id, user);
    return user;
  },
  get(id) {
    return users.get(id) ?? null;
  },
  all() {
    return Array.from(users.values());
  },
};
