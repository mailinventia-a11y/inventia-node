import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceRouter } from '../public/js/core/router.js';

function harness({ grants = ['*'], flags = { trade_workspaces: { enabled: true } } } = {}) {
  const tabs = [];
  const historyCalls = [];
  const originalDocument = globalThis.document;
  const originalSwitchTab = globalThis.switchTab;
  const originalShowToast = globalThis.showToast;
  globalThis.document = {
    querySelectorAll: () => [],
    querySelector: () => null
  };
  globalThis.switchTab = tab => tabs.push(tab);
  globalThis.showToast = () => {};
  const store = {
    state: { featureFlags: flags },
    getState() { return this.state; },
    patch(change) { this.state = { ...this.state, ...change }; }
  };
  const router = new WorkspaceRouter({
    store,
    permissions: () => grants,
    location: { href: 'http://localhost:3000/' },
    history: {
      pushState: (...args) => historyCalls.push(['push', ...args]),
      replaceState: (...args) => historyCalls.push(['replace', ...args])
    }
  });
  router.register({ module: 'workspace', view: 'home', legacyTab: 'dashboard', permission: 'dashboard.read' });
  return {
    router, tabs, historyCalls, store,
    restore() {
      globalThis.document = originalDocument;
      globalThis.switchTab = originalSwitchTab;
      globalThis.showToast = originalShowToast;
    }
  };
}

test('workspace router opens a registered permitted route and records history', async () => {
  const context = harness({ grants: ['dashboard.read', 'trade.read'] });
  let loaded = 0;
  context.router.register({
    module: 'trade', view: 'quotations', legacyTab: 'milestone1-workspace',
    permission: 'trade.read', featureFlag: 'trade_workspaces', load: async () => { loaded += 1; }
  });
  try {
    await context.router.navigate('trade', 'quotations');
    assert.deepEqual(context.tabs, ['milestone1-workspace']);
    assert.equal(loaded, 1);
    assert.equal(context.store.state.workspace.view, 'quotations');
    assert.equal(context.historyCalls[0][0], 'push');
  } finally { context.restore(); }
});

test('workspace router blocks unauthorized and feature-disabled routes before loading', async () => {
  const context = harness({ grants: ['dashboard.read'], flags: { trade_workspaces: { enabled: false } } });
  let loaded = 0;
  context.router.register({
    module: 'trade', view: 'purchase-orders', legacyTab: 'milestone1-workspace',
    permission: 'trade.read', featureFlag: 'trade_workspaces', load: async () => { loaded += 1; }
  });
  try {
    await context.router.navigate('trade', 'purchase-orders');
    assert.equal(loaded, 0);
    assert.deepEqual(context.tabs, ['dashboard']);
    assert.equal(context.store.state.workspace.view, 'home');
  } finally { context.restore(); }
});

test('workspace aliases resolve to the canonical route', async () => {
  const context = harness({ grants: ['dashboard.read', 'inventory.read'] });
  context.router.register({
    module: 'inventory', view: 'movements', legacyTab: 'milestone1-workspace', permission: 'inventory.read',
    aliases: [{ module: 'stock', view: 'timeline' }]
  });
  try {
    await context.router.navigate('stock', 'timeline');
    assert.deepEqual(context.tabs, ['milestone1-workspace']);
    assert.equal(context.store.state.workspace.module, 'inventory');
  } finally { context.restore(); }
});
