export class OrganizationRealtimeClient {
  constructor({ tokenProvider = () => globalThis.localStorage?.getItem('phase5AccessToken') } = {}) {
    this.tokenProvider = tokenProvider;
    this.socket = null;
    this.listeners = new Map();
  }

  connect() {
    if (this.socket || typeof globalThis.io !== 'function') return false;
    const token = this.tokenProvider();
    if (!token) return false;
    this.socket = globalThis.io({
      path: '/realtime',
      auth: { token },
      transports: ['websocket', 'polling']
    });
    for (const [event, handlers] of this.listeners) {
      for (const handler of handlers) this.socket.on(event, handler);
    }
    return true;
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    this.socket?.on(event, handler);
    return () => {
      this.listeners.get(event)?.delete(handler);
      this.socket?.off(event, handler);
    };
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
  }
}
