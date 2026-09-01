export function createEventBus() {
  const listeners = new Map();
  return {
    on(eventName, listener) {
      const group = listeners.get(eventName) ?? new Set();
      group.add(listener);
      listeners.set(eventName, group);
      return () => {};
    },
    off(eventName, listener) {
      listeners.get(eventName)?.delete(listener);
    },
    emit(eventName, payload) {
      for (const listener of listeners.get(eventName) ?? []) listener(payload);
    },
  };
}
