export function createEventBus() {
  const listeners = new Map();
  return {
    on(eventName, listener) {
      const group = listeners.get(eventName) ?? new Set();
      group.add(listener);
      listeners.set(eventName, group);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        group.delete(listener);
      };
    },
    off(eventName) {
      listeners.delete(eventName);
    },
    emit(eventName, payload) {
      for (const listener of [...(listeners.get(eventName) ?? [])]) listener(payload);
    },
  };
}
