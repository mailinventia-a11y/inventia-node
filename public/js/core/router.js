export class WorkspaceRouter {
  constructor({ store, history = globalThis.history, location = globalThis.location } = {}) {
    this.store = store;
    this.history = history;
    this.location = location;
    this.routes = new Map();
    this.installed = false;
    this.onPopState = () => this.restore();
  }

  register({ module, view = 'overview', legacyTab = null, load = null }) {
    if (!module) throw new Error('Workspace route requires a module.');
    this.routes.set(routeKey(module, view), { module, view, legacyTab, load });
    return this;
  }

  install() {
    if (this.installed) return;
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-module][data-view]');
      if (!target || target.hidden) return;
      event.preventDefault();
      this.navigate(target.dataset.module, target.dataset.view);
    });
    globalThis.addEventListener('popstate', this.onPopState);
    this.installed = true;
    this.restore();
  }

  async navigate(module, view = 'overview', { replace = false, parameters = {} } = {}) {
    const definition = this.routes.get(routeKey(module, view))
      || { module, view, legacyTab: document.querySelector(`[data-module="${cssEscape(module)}"][data-view="${cssEscape(view)}"]`)?.dataset.tab };
    if (definition.legacyTab && typeof globalThis.switchTab === 'function') {
      globalThis.switchTab(definition.legacyTab);
    }
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

  activateSidebar(module, view) {
    document.querySelectorAll('[data-module][data-view]').forEach(item => {
      const active = item.dataset.module === module && item.dataset.view === view;
      item.classList.toggle('active', active);
      if (active) item.closest('.nav-dropdown-wrapper')?.classList.add('open');
    });
  }
}

function routeKey(module, view) {
  return `${module}:${view}`;
}

function cssEscape(value) {
  return globalThis.CSS?.escape?.(value) || String(value).replace(/["\\]/g, '\\$&');
}
