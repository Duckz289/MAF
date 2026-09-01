export function createEventBus() {
  const listeners = new Map();
  return {
    on(eventName, listener) {
      const group = listeners.get(eventName) ?? [];
      group.push(listener);
      listeners.set(eventName, group);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = listeners.get(eventName) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
    off(eventName, listener) {
      const group = listeners.get(eventName) ?? [];
      if (group.at(-1) === listener) group.pop();
    },
    emit(eventName, payload) {
      for (const listener of [...(listeners.get(eventName) ?? [])]) listener(payload);
    },
  };
}
