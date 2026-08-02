export function hasPermission(grants = [], requestedPermission = '') {
  if (!requestedPermission) return true;
  return grants.some(grant => {
    if (grant === '*') return true;
    if (grant === requestedPermission) return true;
    return grant.endsWith('.*') && requestedPermission.startsWith(grant.slice(0, -1));
  });
}

export function readStoredPermissions(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem('permissions') || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function applyPermissionVisibility(root = document, grants = readStoredPermissions()) {
  root.querySelectorAll('[data-permission]').forEach(element => {
    const allowed = hasPermission(grants, element.dataset.permission);
    element.hidden = !allowed;
    element.setAttribute('aria-hidden', String(!allowed));
  });
  root.querySelectorAll('.nav-dropdown-wrapper').forEach(wrapper => {
    const entries = [...wrapper.querySelectorAll('.nav-dropdown-item')];
    if (!entries.length) return;
    const visible = entries.some(entry => !entry.hidden);
    wrapper.hidden = !visible;
    wrapper.setAttribute('aria-hidden', String(!visible));
  });
}
