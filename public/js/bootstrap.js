import { InventiaApiClient } from './core/api.js';
import { normalizeError } from './core/errors.js';
import { applyPermissionVisibility, readStoredPermissions } from './core/permissions.js';
import { OrganizationRealtimeClient } from './core/realtime.js';
import { WorkspaceRouter } from './core/router.js';
import { createStateStore } from './core/state.js';

const store = createStateStore({
  ready: false,
  authenticated: false,
  featureFlags: {},
  settings: {},
  workspace: null,
  error: null
});
const api = new InventiaApiClient();
const router = new WorkspaceRouter({ store });
const realtime = new OrganizationRealtimeClient();

async function initializeAuthenticated() {
  const authenticated = Boolean(localStorage.getItem('phase5AccessToken'));
  if (!authenticated) {
    realtime.disconnect();
    store.patch({ ready: true, authenticated: false, featureFlags: {}, settings: {}, error: null });
    return store.getState();
  }

  try {
    const [flagsResult, settingsResult] = await Promise.all([
      api.get('/feature-flags'),
      api.get('/settings')
    ]);
    const featureFlags = flagsResult?.flags || {};
    const settings = settingsResult?.namespaces || {};
    store.patch({ ready: true, authenticated: true, featureFlags, settings, error: null });
    document.documentElement.dataset.frontendModules = featureFlags.frontend_modules?.enabled ? 'enabled' : 'disabled';
    applyPermissionVisibility(document, readStoredPermissions());
    if (featureFlags.navigation_v2?.enabled) router.install();
    realtime.connect();
    window.dispatchEvent(new CustomEvent('inventia:core-ready', { detail: store.getState() }));
    return store.getState();
  } catch (error) {
    const normalized = normalizeError(error);
    store.patch({ ready: true, authenticated: true, error: normalized });
    console.warn('Inventia core initialization failed:', normalized.message);
    return store.getState();
  }
}

window.InventiaCore = Object.freeze({
  api,
  store,
  router,
  realtime,
  initializeAuthenticated
});

window.addEventListener('inventia:session-changed', initializeAuthenticated);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeAuthenticated, { once: true });
} else {
  initializeAuthenticated();
}
