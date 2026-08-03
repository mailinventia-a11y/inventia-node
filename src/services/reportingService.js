import { httpError, parseJson } from '../platform/phase5Http.js';

const DEFINITIONS = Object.freeze([
  ['sales', 'Sales Register', 'Issued invoices with customer and GST totals.'],
  ['inventory', 'Inventory Valuation', 'Warehouse stock, cost, value, and reorder exposure.'],
  ['receivables', 'Receivables', 'Customer invoices with collected and outstanding balances.'],
  ['expenses', 'Expense Register', 'Posted and paid operating expenses.'],
  ['gst', 'GST Summary', 'Taxable value and CGST, SGST, IGST, and cess totals.'],
  ['projects', 'Project Profitability', 'Project budgets, linked revenue, costs, and margin.'],
  ['online-orders', 'Online Orders', 'Public catalogue order review and conversion states.'],
  ['audit', 'Audited Activity', 'Tenant actor, request, entity, and event history.']
]);

export function listReportDefinitions() {
  return DEFINITIONS.map(([key, name, description]) => ({ key, name, description, formats: ['json', 'csv'] }));
}

export async function runReport(db, key, query = {}) {
  const definition = listReportDefinitions().find(item => item.key === key);
  if (!definition) throw httpError(404, 'report_not_found', 'The report was not found.');
  const limit = Math.min(Math.max(Number(query.limit || 500), 1), 5000);
  const from = validDate(query.from) ? query.from : null;
  const to = validDate(query.to) ? query.to : null;
  const filters = { from, to, limit };
  let rows;
  if (key === 'sales') rows = await salesReport(db, filters);
  if (key === 'inventory') rows = await inventoryReport(db, filters);
  if (key === 'receivables') rows = await receivablesReport(db, filters);
  if (key === 'expenses') rows = await expensesReport(db, filters);
  if (key === 'gst') rows = await gstReport(db, filters);
  if (key === 'projects') rows = await projectsReport(db, filters);
  if (key === 'online-orders') rows = await onlineOrdersReport(db, filters);
  if (key === 'audit') rows = await auditReport(db, filters);
  return { report: definition, filters: { from, to }, generated_at: new Date().toISOString(), count: rows.length, rows };
}

export function reportToCsv(result) {
  const columns = [...new Set(result.rows.flatMap(row => Object.keys(row)))];
  if (!columns.length) return 'No records\r\n';
  return [columns.map(csvCell).join(','), ...result.rows.map(row => columns.map(column => csvCell(serialize(row[column]))).join(','))].join('\r\n');
}

async function salesReport(db, { from, to, limit }) {
  const { clause, params } = dateFilter('i.issued_at', from, to);
  return db.all(
    `SELECT i.invoice_number, i.issued_at, c.name AS customer, i.payment_status,
            i.taxable_total_minor, i.cgst_total_minor, i.sgst_total_minor,
            i.igst_total_minor, i.grand_total_minor
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.invoice_status = 'ISSUED'${clause} ORDER BY i.issued_at DESC LIMIT ?`, [...params, limit]
  );
}

async function inventoryReport(db, { limit }) {
  return db.all(
    `SELECT p.sku, p.name AS product, w.code AS warehouse, ws.quantity AS on_hand,
            COALESCE(r.reserved, 0) AS reserved, ws.quantity - COALESCE(r.reserved, 0) AS available,
            COALESCE(p.cost_price, 0) AS unit_cost,
            ROUND(ws.quantity * COALESCE(p.cost_price, 0) * 100) AS inventory_value_minor,
            COALESCE(rr.reorder_point, p.min_stock_alert, 0) AS reorder_point
       FROM warehouse_stock ws JOIN products p ON p.id = ws.product_id JOIN warehouses w ON w.id = ws.warehouse_id
       LEFT JOIN reorder_rules rr ON rr.product_id = ws.product_id AND rr.warehouse_id = ws.warehouse_id
       LEFT JOIN (SELECT product_id, warehouse_id, SUM(quantity - fulfilled_quantity) AS reserved FROM stock_reservations WHERE status = 'active' GROUP BY product_id, warehouse_id) r
         ON r.product_id = ws.product_id AND r.warehouse_id = ws.warehouse_id
      ORDER BY inventory_value_minor DESC, p.name LIMIT ?`, [limit]
  );
}

async function receivablesReport(db, { from, to, limit }) {
  const { clause, params } = dateFilter('i.issued_at', from, to);
  return db.all(
    `SELECT i.invoice_number, i.issued_at, c.name AS customer, i.payment_status,
            i.grand_total_minor,
            COALESCE((SELECT SUM(pa.amount_minor) FROM payment_allocations pa WHERE pa.invoice_id = i.id AND pa.status = 'SUCCESS'), 0)
              - COALESCE((SELECT SUM(r.amount_minor) FROM refunds r WHERE r.invoice_id = i.id AND r.status = 'SUCCESS'), 0) AS net_collected_minor,
            MAX(i.grand_total_minor - (COALESCE((SELECT SUM(pa.amount_minor) FROM payment_allocations pa WHERE pa.invoice_id = i.id AND pa.status = 'SUCCESS'), 0)
              - COALESCE((SELECT SUM(r.amount_minor) FROM refunds r WHERE r.invoice_id = i.id AND r.status = 'SUCCESS'), 0)), 0) AS outstanding_minor
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.invoice_status = 'ISSUED' AND i.payment_status NOT IN ('PAID', 'VOID', 'WRITTEN_OFF')${clause}
      ORDER BY outstanding_minor DESC, i.issued_at LIMIT ?`, [...params, limit]
  );
}

async function expensesReport(db, { from, to, limit }) {
  const { clause, params } = dateFilter('expense_date', from, to);
  return db.all(
    `SELECT e.expense_no, e.expense_date, a.name AS expense_account, s.name AS supplier,
            e.status, e.subtotal_minor, e.tax_minor, e.total_minor, e.reference, e.description
       FROM expenses e JOIN accounts a ON a.id = e.expense_account_id
       LEFT JOIN suppliers s ON s.id = e.supplier_id WHERE 1 = 1${clause}
      ORDER BY e.expense_date DESC LIMIT ?`, [...params, limit]
  );
}

async function gstReport(db, { from, to }) {
  const { clause, params } = dateFilter('issued_at', from, to);
  return db.all(
    `SELECT substr(issued_at, 1, 7) AS period, COUNT(*) AS invoice_count,
            SUM(taxable_total_minor) AS taxable_minor, SUM(cgst_total_minor) AS cgst_minor,
            SUM(sgst_total_minor) AS sgst_minor, SUM(igst_total_minor) AS igst_minor,
            SUM(cess_total_minor) AS cess_minor, SUM(grand_total_minor) AS total_minor
       FROM invoices WHERE invoice_status = 'ISSUED'${clause}
      GROUP BY substr(issued_at, 1, 7) ORDER BY period DESC`, params
  );
}

async function projectsReport(db, { limit }) {
  const rows = await db.all(`SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?`, [limit]);
  const output = [];
  for (const row of rows) {
    const totals = await db.one(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'REVENUE' THEN amount_minor ELSE 0 END), 0) AS revenue_minor,
              COALESCE(SUM(CASE WHEN entry_type = 'COST' THEN amount_minor ELSE 0 END), 0) AS cost_minor
         FROM project_entries WHERE project_id = ?`, [row.id]
    );
    output.push({ project_number: row.project_no, name: row.name, status: row.status, budget_revenue_minor: row.budget_revenue_minor, budget_cost_minor: row.budget_cost_minor, revenue_minor: Number(totals.revenue_minor || 0), cost_minor: Number(totals.cost_minor || 0), profit_minor: Number(totals.revenue_minor || 0) - Number(totals.cost_minor || 0) });
  }
  return output;
}

async function onlineOrdersReport(db, { from, to, limit }) {
  const { clause, params } = dateFilter('created_at', from, to);
  const rows = await safeAll(db, `SELECT order_number, created_at, customer_snapshot, status, grand_total_minor, payment_verified FROM online_orders WHERE 1 = 1${clause} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
  return rows.map(row => ({ ...row, customer: parseJson(row.customer_snapshot, {}).name || '', customer_snapshot: undefined, payment_verified: Boolean(Number(row.payment_verified)) }));
}

async function auditReport(db, { from, to, limit }) {
  const { clause, params } = dateFilter('created_at', from, to);
  return db.all(`SELECT request_id, actor_user_id, event_type, entity_type, entity_id, created_at FROM audit_logs WHERE 1 = 1${clause} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
}

function dateFilter(column, from, to) {
  const parts = []; const params = [];
  if (from) { parts.push(`${column} >= ?`); params.push(`${from}T00:00:00.000Z`); }
  if (to) { parts.push(`${column} <= ?`); params.push(`${to}T23:59:59.999Z`); }
  return { clause: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function serialize(value) { return value && typeof value === 'object' ? JSON.stringify(value) : value; }
async function safeAll(db, sql, params) { try { return await db.all(sql, params); } catch (error) { if (/no such table|does not exist/i.test(error.message)) return []; throw error; } }
