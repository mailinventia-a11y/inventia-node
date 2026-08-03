let definitions = [];
let activeReport = 'sales';

export function installMilestone6({ router, api }) {
  router.register({ module: 'insights', view: 'analytics', legacyTab: 'milestone6-workspace', permission: 'reports.read', load: () => openReportCentre(api) });
  document.getElementById('m6RunReport')?.addEventListener('click', () => runSelectedReport(api));
  document.getElementById('m6ReportSelect')?.addEventListener('change', event => { activeReport = event.target.value; updateDefinition(); });
  document.getElementById('m6Export')?.addEventListener('click', exportSelectedReport);
}

async function openReportCentre(api) {
  setState('Loading reports…');
  try {
    const result = await api.get('/reports'); definitions = result.reports || [];
    const select = document.getElementById('m6ReportSelect');
    select.innerHTML = definitions.map(report => `<option value="${escapeHtml(report.key)}">${escapeHtml(report.name)}</option>`).join('');
    if (!definitions.some(report => report.key === activeReport)) activeReport = definitions[0]?.key || '';
    select.value = activeReport; updateDefinition(); await runSelectedReport(api);
  } catch (error) { setState(error.message || 'Unable to load reports.'); globalThis.showToast?.(error.message, 'error'); }
}

async function runSelectedReport(api) {
  if (!activeReport) return;
  setState('Running report…'); document.getElementById('m6ReportTable').innerHTML = '';
  const query = new URLSearchParams({ limit: '500' });
  const from = document.getElementById('m6ReportFrom').value; const to = document.getElementById('m6ReportTo').value;
  if (from) query.set('from', from); if (to) query.set('to', to);
  try {
    const result = await api.get(`/reports/${activeReport}?${query}`);
    renderKpis([['Records', result.count], ['Report', result.report.name], ['Generated', new Date(result.generated_at).toLocaleTimeString()]]);
    renderRows(result.rows || [], result.report.name);
  } catch (error) { setState(error.message || 'Unable to run the report.'); globalThis.showToast?.(error.message, 'error'); }
}

async function exportSelectedReport() {
  if (!activeReport) return;
  const query = new URLSearchParams({ limit: '5000' });
  const from = document.getElementById('m6ReportFrom').value; const to = document.getElementById('m6ReportTo').value;
  if (from) query.set('from', from); if (to) query.set('to', to);
  try {
    const response = await fetch(`/api/v1/reports/${encodeURIComponent(activeReport)}/export?${query}`, { headers: { authorization: `Bearer ${localStorage.getItem('phase5AccessToken') || ''}` } });
    if (!response.ok) throw new Error('Report export failed.');
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a');
    link.href = url; link.download = `inventia-${activeReport}.csv`; link.click(); URL.revokeObjectURL(url);
    globalThis.showToast?.('Report export downloaded.', 'success');
  } catch (error) { globalThis.showToast?.(error.message, 'error'); }
}

function updateDefinition() {
  const definition = definitions.find(report => report.key === activeReport);
  document.getElementById('m6ReportTitle').textContent = definition?.name || 'Report';
  document.getElementById('m6ReportDescription').textContent = definition?.description || '';
}

function renderRows(rows, caption) {
  const target = document.getElementById('m6ReportTable');
  if (!rows.length) { target.innerHTML = ''; setState('No records match this report period.'); return; }
  setState(''); const columns = [...new Set(rows.flatMap(row => Object.keys(row).filter(key => row[key] !== undefined)))];
  target.innerHTML = `<table><caption class="sr-only">${escapeHtml(caption)}</caption><thead><tr>${columns.map(column => `<th scope="col">${escapeHtml(humanize(column))}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(formatValue(column, row[column]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderKpis(items) { const target = document.getElementById('m6ReportKpis'); target.hidden = false; target.innerHTML = items.map(([label, value]) => `<div class="kpi-card"><div><span>${escapeHtml(label)}</span><h3>${escapeHtml(value)}</h3></div></div>`).join(''); }
function formatValue(column, value) { if (value == null) return '—'; if (column.endsWith('_minor')) return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value) / 100); if (typeof value === 'boolean') return value ? 'Yes' : 'No'; if (typeof value === 'object') return JSON.stringify(value); return String(value); }
function humanize(value) { return String(value).replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase()); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character])); }
function setState(message) { const target = document.getElementById('m6ReportState'); target.hidden = !message; target.textContent = message || ''; }
