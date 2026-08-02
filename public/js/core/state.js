export function createStateStore(initialState = {}) {
  let state = Object.freeze({ ...initialState });
  const listeners = new Set();

  return {
    getState() {
      return state;
    },
    patch(changes) {
      const previous = state;
      const resolved = typeof changes === 'function' ? changes(previous) : changes;
      state = Object.freeze({ ...previous, ...(resolved || {}) });
      for (const listener of listeners) listener(state, previous);
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('State listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
