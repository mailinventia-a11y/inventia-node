import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

const apply = process.argv.includes('--apply');
const root = process.cwd();
const sourceDatabase = path.join(root, 'pos.db');
if (!fs.existsSync(sourceDatabase)) throw new Error('pos.db was not found.');

let migrationDatabase = sourceDatabase;
let temporaryDirectory;
if (!apply) {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-phase5-dry-run-'));
  migrationDatabase = path.join(temporaryDirectory, 'pos.db');
  await snapshotSqlite(sourceDatabase, migrationDatabase);
  process.env.PHASE5_DATA_DIR = path.join(temporaryDirectory, 'control');
  process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${migrationDatabase}`;
  delete process.env.CONTROL_DATABASE_URL;
  delete process.env.TENANT_DATABASE_ADMIN_URL;
} else {
  const backupDirectory = path.join(root, 'data', 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backup = path.join(backupDirectory, `pos-pre-phase5-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await snapshotSqlite(sourceDatabase, backup);
  console.log(`Backup created: ${backup}`);
}

const { initializePhase5Platform } = await import('../src/platform/phase5Database.js');
const { hashPlatformPassword } = await import('../src/platform/phase5Auth.js');
const before = await readMetrics(migrationDatabase);
const { defaultTenant } = await initializePhase5Platform({ hashPassword: hashPlatformPassword });
const after = await readMetrics(migrationDatabase);
const movements = await defaultTenant.one(`SELECT COUNT(*) AS count FROM stock_movements`);

const comparisons = {
  product_count: [before.products, after.products],
  customer_count: [before.customers, after.customers],
  supplier_count: [before.suppliers, after.suppliers],
  sale_count: [before.sales, after.sales],
  sales_total: [before.salesTotal, after.salesTotal],
  stock_total: [before.stockTotal, after.stockTotal]
};
for (const [metric, [left, right]] of Object.entries(comparisons)) {
  if (Number(left) !== Number(right)) throw new Error(`${metric} changed during migration (${left} -> ${right}).`);
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  record_and_total_comparisons: comparisons,
  stock_movements: Number(movements.count),
  result: 'passed'
}, null, 2));

if (temporaryDirectory) {
  console.log(`Dry-run files are isolated at ${temporaryDirectory} and may be removed after review.`);
}

async function readMetrics(filename) {
  const sqlite3 = (await import('sqlite3')).default;
  const db = new sqlite3.Database(filename);
  const one = sql => new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row)));
  try {
    return {
      products: (await one('SELECT COUNT(*) AS value FROM products')).value,
      customers: (await one('SELECT COUNT(*) AS value FROM customers')).value,
      suppliers: (await one('SELECT COUNT(*) AS value FROM suppliers')).value,
      sales: (await one('SELECT COUNT(*) AS value FROM sales')).value,
      salesTotal: (await one('SELECT COALESCE(SUM(total), 0) AS value FROM sales')).value,
      stockTotal: (await one('SELECT COALESCE(SUM(quantity), 0) AS value FROM warehouse_stock')).value
    };
  } finally {
    db.close();
  }
}

async function snapshotSqlite(source, target) {
  const sqlite3 = (await import('sqlite3')).default;
  const db = new sqlite3.Database(source);
  const safeTarget = path.resolve(target).replaceAll("'", "''");
  try {
    await new Promise((resolve, reject) => {
      db.run(`VACUUM INTO '${safeTarget}'`, error => error ? reject(error) : resolve());
    });
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
}
