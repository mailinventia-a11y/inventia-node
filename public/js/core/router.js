export class WorkspaceRouter {
  constructor({ store, history = globalThis.history, location = globalThis.location, permissions = () => [] } = {}) {
    this.store = store;
    this.history = history;
    this.location = location;
    this.routes = new Map();
    this.aliases = new Map();
    this.permissions = permissions;
    this.installed = false;
    this.onPopState = () => this.restore();
  }

  register({ module, view = 'overview', legacyTab = null, load = null, permission = '', featureFlag = '', aliases = [] }) {
    if (!module) throw new Error('Workspace route requires a module.');
    const definition = { module, view, legacyTab, load, permission, featureFlag };
    this.routes.set(routeKey(module, view), definition);
    aliases.forEach(alias => this.aliases.set(routeKey(alias.module, alias.view || 'overview'), definition));
    return this;
  }

  install() {
    if (this.installed) return;
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-module][data-view]');
      if (!target || target.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      this.navigate(target.dataset.module, target.dataset.view);
    }, true);
    globalThis.addEventListener('popstate', this.onPopState);
    this.installed = true;
    this.restore();
  }

  async navigate(module, view = 'overview', { replace = false, parameters = {} } = {}) {
    const definition = this.routes.get(routeKey(module, view))
      || this.aliases.get(routeKey(module, view));
    if (!definition || !this.isAllowed(definition)) {
      if (module !== 'workspace' || view !== 'home') {
        globalThis.showToast?.(definition ? 'You do not have permission to open that workspace.' : 'That workspace is not available.', 'error');
        return this.navigate('workspace', 'home', { replace: true });
      }
      return;
    }
    if (definition.legacyTab && typeof globalThis.switchTab === 'function') {
      globalThis.switchTab(definition.legacyTab);
    }
    module = definition.module;
    view = definition.view;
    this.activateSidebar(module, view);
    this.store?.patch({ workspace: { module, view, parameters } });
    const url = new URL(this.location.href);
    url.searchParams.set('workspace', module);
    url.searchParams.set('view', view);
    this.history?.[replace ? 'replaceState' : 'pushState']?.({ module, view, parameters }, '', url);
    if (typeof definition.load === 'function') await definition.load({ module, view, parameters });
  }

  restore() {
    const url = new URL(this.location.href);
    const module = url.searchParams.get('workspace');
    const view = url.searchParams.get('view') || 'overview';
    if (module) this.navigate(module, view, { replace: true }).catch(() => {});
  }

  isAllowed(definition) {
    const flags = this.store?.getState?.().featureFlags || {};
    if (definition.featureFlag && !flags[definition.featureFlag]?.enabled) return false;
    if (!definition.permission) return true;
    return hasPermission(this.permissions(), definition.permission);
  }

  activateSidebar(module, view) {
    const items = [...document.querySelectorAll('[data-module][data-view]')];
    const hasExact = items.some(item => item.dataset.module === module && item.dataset.view === view);
    items.forEach(item => {
      const active = item.dataset.module === module && item.dataset.view === view;
      const moduleFallback = !hasExact && item.dataset.module === module && ['overview', 'organization'].includes(item.dataset.view);
      item.classList.toggle('active', active || moduleFallback);
      if (active || moduleFallback) item.closest('.nav-dropdown-wrapper')?.classList.add('open');
    });
  }
}

function hasPermission(grants, requestedPermission) {
  return (grants || []).some(grant => grant === '*'
    || grant === requestedPermission
    || (grant.endsWith('.*') && requestedPermission.startsWith(grant.slice(0, -1))));
}

function routeKey(module, view) {
  return `${module}:${view}`;
}

function cssEscape(value) {
  return globalThis.CSS?.escape?.(value) || String(value).replace(/["\\]/g, '\\$&');
}
