import { InventiaApiClient } from './core/api.js';
import { normalizeError } from './core/errors.js';
import { applyPermissionVisibility, readStoredPermissions } from './core/permissions.js';
import { OrganizationRealtimeClient } from './core/realtime.js';
import { WorkspaceRouter } from './core/router.js';
import { createStateStore } from './core/state.js';
import { installMilestone1 } from './milestone1.js';
import { installMilestone3 } from './milestone3.js';
import { installMilestone4 } from './milestone4.js';
import { installMilestone5 } from './milestone5.js';
import { installMilestone6 } from './milestone6.js';

const store = createStateStore({
  ready: false,
  authenticated: false,
  featureFlags: {},
  settings: {},
  workspace: null,
  error: null
});
const api = new InventiaApiClient();
const router = new WorkspaceRouter({ store, permissions: () => readStoredPermissions() });
const realtime = new OrganizationRealtimeClient();
installMilestone1({ router, api, store });
installMilestone3({ router, api, store });
installMilestone4({ router, api, store });
installMilestone5({ router, api, store });
installMilestone6({ router, api, store });

async function initializeAuthenticated() {
  const authenticated = Boolean(localStorage.getItem('phase5AccessToken'));
  if (!authenticated) {
    realtime.disconnect();
    store.patch({ ready: true, authenticated: false, featureFlags: {}, settings: {}, error: null });
    return store.getState();
  }

  // A session-change can begin after the unauthenticated bootstrap has already
  // marked the store ready. Reset readiness so route consumers cannot observe
  // a stale authenticated=false state while flags and settings are loading.
  store.patch({ ready: false, authenticated: true, error: null });
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
    applyFeatureVisibility(featureFlags);
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

function applyFeatureVisibility(featureFlags) {
  const navigationEnabled = Boolean(featureFlags.navigation_v2?.enabled);
  const tradeEnabled = navigationEnabled && Boolean(featureFlags.trade_workspaces?.enabled);
  document.querySelectorAll('[data-module="trade"]').forEach(element => { element.hidden = !tradeEnabled; });
  document.querySelectorAll('[data-tab="milestone1-workspace"]:not([data-module="trade"])').forEach(element => { element.hidden = !navigationEnabled; });
  document.querySelectorAll('[data-feature]').forEach(element => {
    const enabled = Boolean(featureFlags[element.dataset.feature]?.enabled);
    if (!navigationEnabled || !enabled) element.hidden = true;
  });
  document.querySelectorAll('.nav-dropdown-wrapper').forEach(wrapper => {
    const entries = [...wrapper.querySelectorAll('.nav-dropdown-item')];
    if (entries.length) wrapper.hidden = !entries.some(entry => !entry.hidden);
  });
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
