import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import pg from 'pg';

const { Pool } = pg;
const rootDir = process.cwd();
const dataDir = path.resolve(process.env.PHASE5_DATA_DIR || path.join(rootDir, 'data'));
const tenantDir = path.join(dataDir, 'tenants');
const DEFAULT_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_ORGANIZATION_SLUG = process.env.DEFAULT_ORGANIZATION_SLUG || 'northwind-interiors';
const DEFAULT_ORGANIZATION_NAME = process.env.DEFAULT_ORGANIZATION_NAME || 'Northwind Interiors';

let controlDatabase;
let initializationPromise;
const tenantConnections = new Map();
const sqliteLocks = new Map();

export async function initializePhase5Platform({ hashPassword } = {}) {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      fs.mkdirSync(tenantDir, { recursive: true });
      controlDatabase = await createDatabase(process.env.CONTROL_DATABASE_URL || `sqlite:${path.join(dataDir, 'control.db')}`);
      await migrateControlDatabase(controlDatabase);
      await seedDefaultOrganization(hashPassword);
      const defaultTenant = await getTenantDatabase(DEFAULT_ORGANIZATION_ID);
      await migrateTenantDatabase(defaultTenant);
      await importOpeningStock(defaultTenant);
      return { controlDatabase, defaultTenant };
    })();
  }
  return initializationPromise;
}

export function getControlDatabase() {
  if (!controlDatabase) throw new Error('Phase 5 platform has not been initialized.');
  return controlDatabase;
}

export async function getTenantDatabase(organizationId) {
  if (!controlDatabase) await initializePhase5Platform();
  if (tenantConnections.has(organizationId)) return tenantConnections.get(organizationId);
  const registry = await controlDatabase.one(
    'SELECT * FROM tenant_databases WHERE organization_id = ? AND status = ?',
    [organizationId, 'active']
  );
  if (!registry) throw platformError(404, 'tenant_database_not_found', 'The organization database is not configured.');
  const config = decryptTenantConfig(registry.encrypted_config);
  const database = await createDatabase(config.connection);
  await migrateTenantDatabase(database);
  tenantConnections.set(organizationId, database);
  return database;
}

export async function provisionOrganizationDatabase({ organizationId, slug }) {
  if (!controlDatabase) await initializePhase5Platform();
  let connection;
  let driver;
  if (process.env.TENANT_DATABASE_ADMIN_URL) {
    const databaseName = `inventia_${slug.replace(/[^a-z0-9_]/g, '_').slice(0, 40)}`;
    const admin = new Pool({ connectionString: process.env.TENANT_DATABASE_ADMIN_URL });
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.end();
    const target = new URL(process.env.TENANT_DATABASE_ADMIN_URL);
    target.pathname = `/${databaseName}`;
    connection = target.toString();
    driver = 'postgres';
  } else {
    connection = `sqlite:${path.join(tenantDir, `${organizationId}.db`)}`;
    driver = 'sqlite';
  }
  await controlDatabase.run(
    `INSERT INTO tenant_databases
      (organization_id, driver, encrypted_config, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    [organizationId, driver, encryptTenantConfig({ connection }), now(), now()]
  );
  const database = await createDatabase(connection);
  await migrateTenantDatabase(database);
  tenantConnections.set(organizationId, database);
  return database;
}

export async function migrateTenantDatabase(database) {
  await database.transaction(async tx => {
    await prepareInvoicePaymentLegacyTables(tx);
    await prepareBarcodeLabelLegacyTables(tx);
    await prepareFinanceOperationsLegacyTables(tx);
    for (const statement of tenantSchema(database.dialect)) await tx.run(statement);
    const applied = await tx.one('SELECT version FROM migration_versions WHERE version = ?', ['phase5-core-001']);
    if (!applied) {
      await tx.run(
        'INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)',
        ['phase5-core-001', now()]
      );
    }
    const invoicePaymentsApplied = await tx.one(
      'SELECT version FROM migration_versions WHERE version = ?',
      ['phase5-invoice-payments-002']
    );
    if (!invoicePaymentsApplied) {
      await seedPaymentMethods(tx);
      await backfillInvoicePayments(tx);
      await tx.run(
        'INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)',
        ['phase5-invoice-payments-002', now()]
      );
    }
    const barcodeLabelsApplied = await tx.one(
      'SELECT version FROM migration_versions WHERE version = ?',
      ['phase5-barcode-labels-003']
    );
    if (!barcodeLabelsApplied) {
      await seedBarcodeLabelDefaults(tx);
      await backfillBarcodeAssignments(tx);
      await tx.run(
        'INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)',
        ['phase5-barcode-labels-003', now()]
      );
    }
    const settingsFoundationApplied = await tx.one(
      'SELECT version FROM migration_versions WHERE version = ?',
      ['phase6-settings-foundation-001']
    );
    if (!settingsFoundationApplied) {
      await seedSettingsFoundationDefaults(tx);
      await tx.run(
        'INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)',
        ['phase6-settings-foundation-001', now()]
      );
    }
    const documentEngineApplied = await tx.one(
      'SELECT version FROM migration_versions WHERE version = ?',
      ['phase6-document-engine-002']
    );
    if (!documentEngineApplied) {
      const invoiceColumns = await tableColumns(tx, 'invoices');
      if (!invoiceColumns.includes('document_settings_snapshot')) {
        await tx.run(`ALTER TABLE invoices ADD COLUMN document_settings_snapshot ${database.dialect === 'postgres' ? 'JSONB' : 'TEXT'}`);
      }
      await seedDocumentEngineDefaults(tx);
      await tx.run(
        'INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)',
        ['phase6-document-engine-002', now()]
      );
    }
    const financeEngineApplied = await tx.one(
      'SELECT version FROM migration_versions WHERE version = ?',
      ['phase7-finance-operations-003']
    );
    if (!financeEngineApplied) {
      const accountColumns = await tableColumns(tx, 'accounts');
      const accountAdditions = [
        ['parent_id', 'INTEGER'], ['opening_balance_minor', 'INTEGER NOT NULL DEFAULT 0'],
        ['currency', "TEXT NOT NULL DEFAULT 'INR'"], ['merged_into_id', 'INTEGER'],
        ['updated_at', 'TEXT']
      ];
      for (const [column, definition] of accountAdditions) {
        if (!accountColumns.includes(column)) await tx.run(`ALTER TABLE accounts ADD COLUMN ${column} ${definition}`);
      }
      await seedFinanceOperationsDefaults(tx);
      await tx.run(
        'INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)',
        ['phase7-finance-operations-003', now()]
      );
    }
    const operationsEngineApplied = await tx.one(
      'SELECT version FROM migration_versions WHERE version = ?',
      ['phase7-payment-projects-004']
    );
    if (!operationsEngineApplied) {
      await tx.run(
        'INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)',
        ['phase7-payment-projects-004', now()]
      );
    }
    const complianceEngineApplied = await tx.one(
      'SELECT version FROM migration_versions WHERE version = ?',
      ['phase8-subscriptions-compliance-005']
    );
    if (!complianceEngineApplied) {
      await seedSubscriptionsComplianceDefaults(tx);
      await tx.run(
        'INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)',
        ['phase8-subscriptions-compliance-005', now()]
      );
    }
  });
}

async function prepareBarcodeLabelLegacyTables(tx) {
  const canonicalColumns = {
    barcode_templates: 'configuration',
    barcode_print_jobs: 'job_number'
  };
  for (const [table, requiredColumn] of Object.entries(canonicalColumns)) {
    const columns = await tableColumns(tx, table);
    if (!columns.length || columns.includes(requiredColumn)) continue;
    const legacyTable = `legacy_${table}_phase3`;
    const legacyColumns = await tableColumns(tx, legacyTable);
    if (!legacyColumns.length) {
      await tx.run(`ALTER TABLE ${table} RENAME TO ${legacyTable}`);
    } else {
      throw platformError(
        409,
        'legacy_barcode_schema_conflict',
        `Both ${table} and ${legacyTable} use legacy barcode schemas; manual migration is required.`
      );
    }
  }
}

async function prepareInvoicePaymentLegacyTables(tx) {
  const canonicalColumns = {
    invoices: 'invoice_number',
    invoice_items: 'invoice_id',
    payments: 'payment_number',
    payment_allocations: 'invoice_id'
  };
  for (const [table, requiredColumn] of Object.entries(canonicalColumns)) {
    const columns = await tableColumns(tx, table);
    if (!columns.length || columns.includes(requiredColumn)) continue;
    const legacyTable = `legacy_${table}_phase4`;
    const legacyColumns = await tableColumns(tx, legacyTable);
    if (!legacyColumns.length) {
      await tx.run(`ALTER TABLE ${table} RENAME TO ${legacyTable}`);
    } else {
      throw platformError(
        409,
        'legacy_schema_conflict',
        `Both ${table} and ${legacyTable} use legacy schemas; manual migration is required.`
      );
    }
  }
}

async function prepareFinanceOperationsLegacyTables(tx) {
  const canonicalColumns = {
    journals: 'total_debit_minor',
    journal_entries: 'debit_minor',
    bank_transactions: 'reconciliation_status',
    expenses: 'total_minor'
  };
  for (const [table, requiredColumn] of Object.entries(canonicalColumns)) {
    const columns = await tableColumns(tx, table);
    if (!columns.length || columns.includes(requiredColumn)) continue;
    const legacyTable = `legacy_${table}_phase6`;
    const legacyColumns = await tableColumns(tx, legacyTable);
    if (!legacyColumns.length) await tx.run(`ALTER TABLE ${table} RENAME TO ${legacyTable}`);
    else throw platformError(409, 'legacy_finance_schema_conflict', `Both ${table} and ${legacyTable} use legacy finance schemas; manual migration is required.`);
  }
}

async function tableColumns(tx, table) {
  if (tx.dialect === 'postgres') {
    const rows = await tx.all(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ?`,
      [table]
    );
    return rows.map(row => row.column_name);
  }
  const rows = await tx.all(`PRAGMA table_info(${table})`);
  return rows.map(row => row.name);
}

export async function importOpeningStock(database) {
  const marker = await database.one('SELECT version FROM migration_versions WHERE version = ?', ['phase5-opening-stock-001']);
  if (marker) return;
  await database.transaction(async tx => {
    const balances = await tx.all(
      `SELECT ws.warehouse_id, ws.product_id, ws.quantity, COALESCE(p.cost_price, 0) AS unit_cost
       FROM warehouse_stock ws
       LEFT JOIN products p ON p.id = ws.product_id`
    );
    for (const balance of balances) {
      if (!Number(balance.quantity)) continue;
      const unitCost = Number(balance.unit_cost || 0);
      const totalValue = Number(balance.quantity) * unitCost;
      await tx.run(
        `INSERT INTO stock_movements
          (movement_no, movement_type, product_id, warehouse_id, quantity, unit_cost, total_cost,
           reference_type, reference_id, notes, occurred_at, created_at)
         VALUES (?, 'opening', ?, ?, ?, ?, ?, 'legacy_import', ?, ?, ?, ?)`,
        [
          `OPEN-${balance.warehouse_id}-${balance.product_id}`,
          balance.product_id,
          balance.warehouse_id,
          Number(balance.quantity),
          unitCost,
          totalValue,
          String(balance.product_id),
          'Imported from the existing warehouse balance.',
          now(),
          now()
        ]
      );
      await tx.run(
        `INSERT INTO inventory_valuation_state
          (warehouse_id, product_id, valuation_method, on_hand, average_cost, total_value, updated_at)
         VALUES (?, ?, 'weighted_average', ?, ?, ?, ?)
         ON CONFLICT (warehouse_id, product_id) DO UPDATE SET
           on_hand = excluded.on_hand,
           average_cost = excluded.average_cost,
           total_value = excluded.total_value,
           updated_at = excluded.updated_at`,
        [balance.warehouse_id, balance.product_id, Number(balance.quantity), unitCost, totalValue, now()]
      );
    }
    await tx.run('INSERT INTO migration_versions (version, applied_at) VALUES (?, ?)', ['phase5-opening-stock-001', now()]);
  });
}

async function seedDefaultOrganization(hashPassword) {
  const existing = await controlDatabase.one('SELECT id FROM organizations WHERE id = ?', [DEFAULT_ORGANIZATION_ID]);
  if (!existing) {
    await controlDatabase.run(
      `INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      [DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_SLUG, DEFAULT_ORGANIZATION_NAME, now(), now()]
    );
  }
  const tenantRegistry = await controlDatabase.one(
    'SELECT organization_id FROM tenant_databases WHERE organization_id = ?',
    [DEFAULT_ORGANIZATION_ID]
  );
  if (!tenantRegistry) {
    if (process.env.TENANT_DATABASE_ADMIN_URL) {
      await provisionOrganizationDatabase({
        organizationId: DEFAULT_ORGANIZATION_ID,
        slug: DEFAULT_ORGANIZATION_SLUG
      });
    } else {
      await controlDatabase.run(
        `INSERT INTO tenant_databases
          (organization_id, driver, encrypted_config, status, created_at, updated_at)
         VALUES (?, 'sqlite', ?, 'active', ?, ?)`,
        [
          DEFAULT_ORGANIZATION_ID,
          encryptTenantConfig({ connection: process.env.DEFAULT_TENANT_DATABASE_URL || `sqlite:${path.join(rootDir, 'pos.db')}` }),
          now(),
          now()
        ]
      );
    }
  }
  if (!hashPassword) return;
  const users = [
    { id: '00000000-0000-4000-8000-000000000101', username: 'admin', password: 'admin123', fullName: 'System Admin', email: 'admin@inventia.com', role: 'admin' },
    { id: '00000000-0000-4000-8000-000000000102', username: 'vivin', password: 'manager123', fullName: 'Vivin Store Manager', email: 'manager@inventia.com', role: 'manager' }
  ];
  for (const user of users) {
    let account = await controlDatabase.one('SELECT id FROM platform_users WHERE username = ?', [user.username]);
    if (!account) {
      await controlDatabase.run(
        `INSERT INTO platform_users
          (id, username, email, password_hash, full_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [user.id, user.username, user.email, await hashPassword(user.password), user.fullName, now(), now()]
      );
      account = { id: user.id };
    }
    const membership = await controlDatabase.one(
      'SELECT id FROM memberships WHERE organization_id = ? AND user_id = ?',
      [DEFAULT_ORGANIZATION_ID, account.id]
    );
    if (!membership) {
      await controlDatabase.run(
        `INSERT INTO memberships
          (id, organization_id, user_id, role, permissions, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [crypto.randomUUID(), DEFAULT_ORGANIZATION_ID, account.id, user.role, JSON.stringify(rolePermissions(user.role)), now(), now()]
      );
    }
  }
}

async function migrateControlDatabase(database) {
  await database.transaction(async tx => {
    for (const statement of controlSchema(database.dialect)) await tx.run(statement);
    const applied = await tx.one('SELECT version FROM control_migration_versions WHERE version = ?', ['phase7-operations-rbac-001']);
    if (!applied) {
      const managers = await tx.all(`SELECT id, permissions FROM memberships WHERE role = 'manager'`);
      for (const manager of managers) {
        let permissions;
        try { permissions = typeof manager.permissions === 'string' ? JSON.parse(manager.permissions) : manager.permissions; } catch { permissions = []; }
        const merged = [...new Set([...(Array.isArray(permissions) ? permissions : []), 'projects.*', 'reminders.*'])];
        await tx.run('UPDATE memberships SET permissions = ?, updated_at = ? WHERE id = ?', [JSON.stringify(merged), now(), manager.id]);
      }
      await tx.run('INSERT INTO control_migration_versions (version, applied_at) VALUES (?, ?)', ['phase7-operations-rbac-001', now()]);
    }
    const complianceRbac = await tx.one('SELECT version FROM control_migration_versions WHERE version = ?', ['phase8-compliance-rbac-002']);
    if (!complianceRbac) {
      const managers = await tx.all(`SELECT id, permissions FROM memberships WHERE role = 'manager'`);
      for (const manager of managers) {
        let permissions;
        try { permissions = typeof manager.permissions === 'string' ? JSON.parse(manager.permissions) : manager.permissions; } catch { permissions = []; }
        const merged = [...new Set([...(Array.isArray(permissions) ? permissions : []), 'subscriptions.*', 'compliance.read', 'compliance.prepare', 'compliance.file'])];
        await tx.run('UPDATE memberships SET permissions = ?, updated_at = ? WHERE id = ?', [JSON.stringify(merged), now(), manager.id]);
      }
      await tx.run('INSERT INTO control_migration_versions (version, applied_at) VALUES (?, ?)', ['phase8-compliance-rbac-002', now()]);
    }
  });
}

export async function createDatabase(connection) {
  if (connection.startsWith('postgres://') || connection.startsWith('postgresql://')) {
    const pool = new Pool({ connectionString: connection, max: Number(process.env.DB_POOL_SIZE || 10) });
    return new Phase5Database('postgres', pool);
  }
  const filename = connection.replace(/^sqlite:/, '');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new sqlite3.Database(filename);
  await new Promise((resolve, reject) => sqlite.run('PRAGMA foreign_keys = ON', error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => sqlite.run('PRAGMA journal_mode = WAL', error => error ? reject(error) : resolve()));
  return new Phase5Database('sqlite', sqlite, filename);
}

class Phase5Database {
  constructor(dialect, client, identifier = '') {
    this.dialect = dialect;
    this.client = client;
    this.identifier = identifier;
  }

  async all(sql, params = [], client = this.client) {
    if (this.dialect === 'postgres') {
      const result = await client.query(toPostgresParams(sql), params);
      return result.rows;
    }
    return new Promise((resolve, reject) => client.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
  }

  async one(sql, params = [], client = this.client) {
    const rows = await this.all(sql, params, client);
    return rows[0] || null;
  }

  async run(sql, params = [], client = this.client) {
    if (this.dialect === 'postgres') {
      const result = await client.query(toPostgresParams(sql), params);
      return { changes: result.rowCount, rows: result.rows };
    }
    return new Promise((resolve, reject) => client.run(sql, params, function callback(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes, rows: [] });
    }));
  }

  async transaction(work) {
    if (this.dialect === 'postgres') {
      const client = await this.client.connect();
      try {
        await client.query('BEGIN');
        const tx = this.scoped(client);
        const result = await work(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return withSqliteLock(this.identifier, async () => {
      await this.run('BEGIN IMMEDIATE');
      try {
        const result = await work(this);
        await this.run('COMMIT');
        return result;
      } catch (error) {
        await this.run('ROLLBACK');
        throw error;
      }
    });
  }

  scoped(client) {
    return {
      dialect: this.dialect,
      all: (sql, params) => this.all(sql, params, client),
      one: (sql, params) => this.one(sql, params, client),
      run: (sql, params) => this.run(sql, params, client)
    };
  }
}

function controlSchema(dialect) {
  const jsonType = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  return [
    `CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', settings ${jsonType},
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS platform_users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT,
      password_hash TEXT NOT NULL, full_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', last_login_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      user_id TEXT NOT NULL REFERENCES platform_users(id), role TEXT NOT NULL,
      permissions ${jsonType} NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (organization_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL, user_agent TEXT, ip_address TEXT,
      expires_at TEXT NOT NULL, revoked_at TEXT, rotated_from TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_databases (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
      driver TEXT NOT NULL, encrypted_config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', migration_version TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS control_audit_logs (
      id TEXT PRIMARY KEY, organization_id TEXT, actor_user_id TEXT,
      event_type TEXT NOT NULL, request_id TEXT, ip_address TEXT,
      metadata ${jsonType}, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS control_migration_versions (
      version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    )`
  ];
}

function tenantSchema(dialect) {
  const id = dialect === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const json = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  return [
    `CREATE TABLE IF NOT EXISTS migration_versions (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS brands (
      id ${id}, name TEXT NOT NULL, code TEXT UNIQUE, logo_url TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id ${id}, name TEXT NOT NULL, parent_id INTEGER, description TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS products (
      id ${id}, sku TEXT UNIQUE NOT NULL, barcode TEXT UNIQUE, name TEXT NOT NULL,
      brand_id INTEGER, category_id INTEGER, description TEXT, uom TEXT DEFAULT 'piece',
      coverage_per_box REAL, cost_price REAL DEFAULT 0, selling_price REAL DEFAULT 0,
      material TEXT, finish TEXT, dimensions TEXT, shade_lot_number TEXT,
      min_stock_alert INTEGER DEFAULT 5, image_url TEXT, status INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS warehouses (
      id ${id}, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
      type TEXT DEFAULT 'warehouse', address TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS warehouse_stock (
      id ${id}, warehouse_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      quantity REAL DEFAULT 0, bin_location TEXT, updated_at TEXT,
      UNIQUE (warehouse_id, product_id)
    )`,
    `CREATE TABLE IF NOT EXISTS customers (
      id ${id}, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT,
      credit_limit REAL DEFAULT 0, balance REAL DEFAULT 0,
      loyalty_points INTEGER DEFAULT 0, tier TEXT DEFAULT 'bronze', created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS suppliers (
      id ${id}, name TEXT NOT NULL, phone TEXT, email TEXT, gstin TEXT, address TEXT,
      payment_terms INTEGER DEFAULT 0, status INTEGER DEFAULT 1, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id ${id}, invoice_no TEXT UNIQUE NOT NULL, customer_id INTEGER, warehouse_id INTEGER,
      user_id TEXT, subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, tax_amount REAL DEFAULT 0,
      total REAL DEFAULT 0, payment_method TEXT, payment_status TEXT, sale_date TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sale_items (
      id ${id}, sale_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      quantity REAL NOT NULL, unit_price REAL NOT NULL, total_price REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS accounts (
      id ${id}, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      account_type TEXT NOT NULL, parent_id INTEGER, opening_balance REAL DEFAULT 0,
      opening_balance_minor INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'INR',
      is_archived INTEGER DEFAULT 0, merged_into_id INTEGER, created_at TEXT, updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS journals (
      id ${id}, journal_no TEXT UNIQUE NOT NULL, journal_type TEXT NOT NULL DEFAULT 'GENERAL',
      journal_date TEXT NOT NULL, reference TEXT, description TEXT,
      source_type TEXT, source_id TEXT, status TEXT NOT NULL DEFAULT 'POSTED',
      total_debit_minor INTEGER NOT NULL, total_credit_minor INTEGER NOT NULL,
      reversal_of_id INTEGER REFERENCES journals(id) ON DELETE RESTRICT,
      idempotency_key TEXT UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (source_type, source_id, journal_type),
      CHECK (status IN ('POSTED', 'REVERSED')),
      CHECK (total_debit_minor > 0 AND total_debit_minor = total_credit_minor)
    )`,
    `CREATE TABLE IF NOT EXISTS journal_entries (
      id ${id}, journal_id INTEGER NOT NULL REFERENCES journals(id) ON DELETE RESTRICT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      debit_minor INTEGER NOT NULL DEFAULT 0, credit_minor INTEGER NOT NULL DEFAULT 0,
      party_type TEXT, party_id INTEGER, project_id INTEGER, description TEXT,
      created_at TEXT NOT NULL,
      CHECK (debit_minor >= 0 AND credit_minor >= 0),
      CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0))
    )`,
    `CREATE TABLE IF NOT EXISTS bank_accounts (
      id ${id}, account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
      name TEXT NOT NULL, account_number_masked TEXT NOT NULL, ifsc TEXT, upi_id TEXT,
      opening_balance_minor INTEGER NOT NULL DEFAULT 0, current_balance_minor INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'INR', status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (status IN ('active', 'inactive'))
    )`,
    `CREATE TABLE IF NOT EXISTS bank_transactions (
      id ${id}, bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
      journal_id INTEGER NOT NULL REFERENCES journals(id) ON DELETE RESTRICT,
      direction TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT,
      reference TEXT, description TEXT, transaction_date TEXT NOT NULL,
      reconciliation_status TEXT NOT NULL DEFAULT 'UNRECONCILED',
      reconciled_at TEXT, reconciled_by TEXT, idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      CHECK (direction IN ('IN', 'OUT')),
      CHECK (amount_minor > 0),
      CHECK (reconciliation_status IN ('UNRECONCILED', 'RECONCILED'))
    )`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id ${id}, expense_no TEXT UNIQUE NOT NULL, supplier_id INTEGER REFERENCES suppliers(id),
      expense_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      payment_account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
      subtotal_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL DEFAULT 0,
      total_minor INTEGER NOT NULL, expense_date TEXT NOT NULL, description TEXT,
      reference TEXT, status TEXT NOT NULL DEFAULT 'DRAFT', journal_id INTEGER REFERENCES journals(id),
      project_id INTEGER, idempotency_key TEXT UNIQUE, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (status IN ('DRAFT', 'POSTED', 'PAID', 'VOID')),
      CHECK (subtotal_minor >= 0 AND tax_minor >= 0 AND total_minor > 0)
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id ${id}, project_no TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id), status TEXT NOT NULL DEFAULT 'PLANNED',
      start_date TEXT, end_date TEXT, budget_revenue_minor INTEGER NOT NULL DEFAULT 0,
      budget_cost_minor INTEGER NOT NULL DEFAULT 0, description TEXT, metadata ${json},
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (status IN ('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'))
    )`,
    `CREATE TABLE IF NOT EXISTS project_entries (
      id ${id}, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      entry_type TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT,
      amount_minor INTEGER NOT NULL, occurred_at TEXT NOT NULL, description TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      CHECK (entry_type IN ('REVENUE', 'COST')),
      CHECK (amount_minor > 0)
    )`,
    `CREATE TABLE IF NOT EXISTS project_documents (
      id ${id}, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, relationship_type TEXT NOT NULL DEFAULT 'related',
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      CHECK (entity_type IN ('invoice', 'trade_document', 'expense')),
      UNIQUE (project_id, entity_type, entity_id)
    )`,
    `CREATE TABLE IF NOT EXISTS reminders (
      id ${id}, reminder_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      recipient_type TEXT NOT NULL, recipient_id TEXT, channel TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SCHEDULED',
      subject TEXT, message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, sent_at TEXT, cancelled_at TEXT, idempotency_key TEXT UNIQUE,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (channel IN ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP')),
      CHECK (status IN ('SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED'))
    )`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id ${id}, subscription_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'DRAFT', frequency TEXT NOT NULL,
      interval_count INTEGER NOT NULL DEFAULT 1, start_date TEXT NOT NULL, end_date TEXT,
      next_run_at TEXT, last_run_at TEXT, due_days INTEGER NOT NULL DEFAULT 0,
      price_policy TEXT NOT NULL DEFAULT 'SNAPSHOT', currency TEXT NOT NULL DEFAULT 'INR',
      items_snapshot ${json} NOT NULL, invoice_details ${json}, delivery_channels ${json},
      notes TEXT, created_by TEXT NOT NULL, activated_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
      CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')),
      CHECK (interval_count > 0 AND due_days >= 0),
      CHECK (price_policy IN ('SNAPSHOT', 'CURRENT_APPROVED'))
    )`,
    `CREATE TABLE IF NOT EXISTS subscription_runs (
      id ${id}, subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
      occurrence_key TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT, sale_id INTEGER REFERENCES sales(id),
      attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
      started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED')),
      UNIQUE (subscription_id, occurrence_key)
    )`,
    `CREATE TABLE IF NOT EXISTS compliance_documents (
      id ${id}, compliance_type TEXT NOT NULL, invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
      trade_document_id INTEGER REFERENCES trade_documents(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'PREPARED', document_number TEXT,
      provider TEXT, provider_reference TEXT, irn TEXT, acknowledgement_number TEXT,
      acknowledgement_at TEXT, signed_qr TEXT, valid_until TEXT,
      request_snapshot ${json} NOT NULL, response_snapshot ${json}, error_code TEXT, error_message TEXT,
      generated_at TEXT, cancelled_at TEXT, cancellation_reason TEXT,
      idempotency_key TEXT UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (compliance_type IN ('E_INVOICE', 'E_WAY_BILL')),
      CHECK (status IN ('PREPARED', 'PENDING', 'GENERATED', 'FAILED', 'CANCELLED'))
    )`,
    `CREATE TABLE IF NOT EXISTS gst_return_periods (
      id ${id}, return_type TEXT NOT NULL, period TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT', summary ${json} NOT NULL,
      provider TEXT, provider_reference TEXT, error_code TEXT, error_message TEXT,
      prepared_by TEXT, prepared_at TEXT, approval_requested_by TEXT, approval_requested_at TEXT,
      approved_by TEXT, approved_at TEXT, filed_by TEXT, filed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (return_type IN ('GSTR_1', 'GSTR_2B', 'GSTR_3B', 'GSTR_7', 'IMS')),
      CHECK (status IN ('DRAFT', 'PREPARED', 'PENDING_APPROVAL', 'APPROVED', 'FILED', 'FAILED')),
      UNIQUE (return_type, period)
    )`,
    `CREATE TABLE IF NOT EXISTS gst_reconciliation_rows (
      id ${id}, return_id INTEGER NOT NULL REFERENCES gst_return_periods(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL, source_id TEXT, counterparty_gstin TEXT,
      document_number TEXT, document_date TEXT, taxable_minor INTEGER NOT NULL DEFAULT 0,
      tax_minor INTEGER NOT NULL DEFAULT 0, match_status TEXT NOT NULL DEFAULT 'UNMATCHED',
      ims_action TEXT, metadata ${json}, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (match_status IN ('MATCHED', 'MISMATCH', 'UNMATCHED', 'MISSING_BOOKS', 'MISSING_PORTAL')),
      CHECK (ims_action IS NULL OR ims_action IN ('ACCEPT', 'REJECT', 'PENDING'))
    )`,
    `CREATE TABLE IF NOT EXISTS compliance_events (
      id ${id}, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL,
      actor_user_id TEXT, request_id TEXT, sanitized_payload ${json}, error_message TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS product_commerce (
      product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      hsn_code TEXT, gst_rate REAL DEFAULT 0, minimum_price REAL DEFAULT 0,
      maximum_price REAL, valuation_method TEXT DEFAULT 'weighted_average',
      track_batches INTEGER DEFAULT 0, track_serials INTEGER DEFAULT 0,
      metadata ${json}, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS product_variants (
      id ${id}, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku TEXT UNIQUE NOT NULL, barcode TEXT UNIQUE, name TEXT NOT NULL,
      attributes ${json}, cost_price REAL DEFAULT 0, selling_price REAL DEFAULT 0,
      status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS units (
      id ${id}, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      precision_digits INTEGER DEFAULT 2, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tax_profiles (
      id ${id}, name TEXT NOT NULL, tax_type TEXT NOT NULL, rate REAL NOT NULL,
      hsn_prefix TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS price_lists (
      id ${id}, name TEXT NOT NULL, currency TEXT DEFAULT 'INR',
      valid_from TEXT, valid_to TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS price_list_items (
      id ${id}, price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id), variant_id INTEGER,
      unit_price REAL NOT NULL, minimum_quantity REAL DEFAULT 1,
      UNIQUE (price_list_id, product_id, variant_id, minimum_quantity)
    )`,
    `CREATE TABLE IF NOT EXISTS supplier_products (
      id ${id}, supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      supplier_sku TEXT, lead_time_days INTEGER DEFAULT 0, minimum_order_quantity REAL DEFAULT 1,
      last_cost REAL DEFAULT 0, preferred INTEGER DEFAULT 0,
      UNIQUE (supplier_id, product_id)
    )`,
    `CREATE TABLE IF NOT EXISTS product_media (
      id ${id}, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      file_key TEXT NOT NULL, media_type TEXT NOT NULL, display_order INTEGER DEFAULT 0,
      metadata ${json}, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS party_profiles (
      party_type TEXT NOT NULL, party_id INTEGER NOT NULL, gstin TEXT,
      legal_name TEXT, payment_terms_days INTEGER DEFAULT 0, lead_time_days INTEGER DEFAULT 0,
      rating REAL, tags ${json}, notes TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (party_type, party_id)
    )`,
    `CREATE TABLE IF NOT EXISTS party_contacts (
      id ${id}, party_type TEXT NOT NULL, party_id INTEGER NOT NULL,
      name TEXT NOT NULL, title TEXT, email TEXT, phone TEXT,
      is_primary INTEGER DEFAULT 0, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS party_addresses (
      id ${id}, party_type TEXT NOT NULL, party_id INTEGER NOT NULL,
      address_type TEXT DEFAULT 'billing', line1 TEXT NOT NULL, line2 TEXT,
      city TEXT, state TEXT, postal_code TEXT, country TEXT DEFAULT 'IN',
      is_primary INTEGER DEFAULT 0, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS party_communications (
      id ${id}, party_type TEXT NOT NULL, party_id INTEGER NOT NULL,
      channel TEXT NOT NULL, direction TEXT NOT NULL, subject TEXT, body TEXT,
      occurred_at TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS inventory_batches (
      id ${id}, product_id INTEGER NOT NULL REFERENCES products(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), batch_no TEXT NOT NULL,
      manufactured_at TEXT, expires_at TEXT, quantity REAL DEFAULT 0,
      unit_cost REAL DEFAULT 0, status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, UNIQUE (product_id, warehouse_id, batch_no)
    )`,
    `CREATE TABLE IF NOT EXISTS inventory_serials (
      id ${id}, product_id INTEGER NOT NULL REFERENCES products(id),
      warehouse_id INTEGER REFERENCES warehouses(id), serial_no TEXT UNIQUE NOT NULL,
      batch_id INTEGER REFERENCES inventory_batches(id), status TEXT DEFAULT 'available',
      reference_type TEXT, reference_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS stock_movements (
      id ${id}, movement_no TEXT UNIQUE NOT NULL, movement_type TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id), variant_id INTEGER,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), batch_id INTEGER,
      quantity REAL NOT NULL, unit_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0,
      reference_type TEXT, reference_id TEXT, notes TEXT, actor_user_id TEXT,
      occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS stock_reservations (
      id ${id}, reservation_no TEXT UNIQUE NOT NULL, product_id INTEGER NOT NULL,
      variant_id INTEGER, warehouse_id INTEGER NOT NULL, quantity REAL NOT NULL,
      fulfilled_quantity REAL DEFAULT 0, reference_type TEXT NOT NULL, reference_id TEXT NOT NULL,
      status TEXT DEFAULT 'active', expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reorder_rules (
      id ${id}, product_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL,
      minimum_stock REAL DEFAULT 0, reorder_point REAL DEFAULT 0,
      reorder_quantity REAL DEFAULT 0, safety_stock REAL DEFAULT 0,
      preferred_supplier_id INTEGER, lead_time_days INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active', updated_at TEXT NOT NULL,
      UNIQUE (product_id, warehouse_id)
    )`,
    `CREATE TABLE IF NOT EXISTS cycle_counts (
      id ${id}, count_no TEXT UNIQUE NOT NULL, warehouse_id INTEGER NOT NULL,
      status TEXT DEFAULT 'draft', scheduled_at TEXT, completed_at TEXT,
      created_by TEXT, approved_by TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cycle_count_items (
      id ${id}, cycle_count_id INTEGER NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL, expected_quantity REAL NOT NULL,
      counted_quantity REAL, variance REAL, notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS inventory_cost_layers (
      id ${id}, warehouse_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      source_movement_id INTEGER NOT NULL, received_at TEXT NOT NULL,
      original_quantity REAL NOT NULL, remaining_quantity REAL NOT NULL,
      unit_cost REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS inventory_valuation_state (
      warehouse_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      valuation_method TEXT NOT NULL DEFAULT 'weighted_average',
      on_hand REAL DEFAULT 0, average_cost REAL DEFAULT 0,
      total_value REAL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY (warehouse_id, product_id)
    )`,
    `CREATE TABLE IF NOT EXISTS trade_documents (
      id ${id}, document_no TEXT UNIQUE NOT NULL, document_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', party_type TEXT, party_id INTEGER,
      warehouse_id INTEGER, currency TEXT DEFAULT 'INR', subtotal REAL DEFAULT 0,
      discount REAL DEFAULT 0, tax_total REAL DEFAULT 0, grand_total REAL DEFAULT 0,
      source_document_id INTEGER, expected_at TEXT, notes TEXT, metadata ${json},
      created_by TEXT, approved_by TEXT, approved_at TEXT, fulfilled_at TEXT,
      cancelled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS trade_document_lines (
      id ${id}, document_id INTEGER NOT NULL REFERENCES trade_documents(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL, variant_id INTEGER, description TEXT,
      quantity REAL NOT NULL, fulfilled_quantity REAL DEFAULT 0,
      unit_price REAL NOT NULL, discount REAL DEFAULT 0, tax_rate REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0, line_total REAL NOT NULL, metadata ${json}
    )`,
    `CREATE TABLE IF NOT EXISTS document_links (
      id ${id}, source_entity_type TEXT NOT NULL, source_entity_id INTEGER NOT NULL,
      target_entity_type TEXT NOT NULL, target_entity_id INTEGER NOT NULL,
      relationship_type TEXT NOT NULL, metadata ${json}, created_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (source_entity_type, source_entity_id, target_entity_type, target_entity_id, relationship_type)
    )`,
    `CREATE TABLE IF NOT EXISTS document_templates (
      id ${id}, name TEXT NOT NULL, document_type TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'A4', configuration ${json} NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (format IN ('A4', 'THERMAL')),
      CHECK (is_default IN (0, 1)),
      CHECK (status IN ('active', 'inactive'))
    )`,
    `CREATE TABLE IF NOT EXISTS goods_receipts (
      id ${id}, receipt_no TEXT UNIQUE NOT NULL, purchase_order_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL, supplier_id INTEGER, status TEXT DEFAULT 'completed',
      received_at TEXT NOT NULL, received_by TEXT, notes TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS goods_receipt_items (
      id ${id}, goods_receipt_id INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
      trade_line_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      quantity REAL NOT NULL, unit_cost REAL NOT NULL, batch_no TEXT, expires_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS approval_requests (
      id ${id}, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending', requested_by TEXT NOT NULL, assigned_role TEXT,
      reason TEXT, decision_notes TEXT, decided_by TEXT, decided_at TEXT,
      created_at TEXT NOT NULL, UNIQUE (entity_type, entity_id, status)
    )`,
    `CREATE TABLE IF NOT EXISTS entity_timeline (
      id ${id}, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL, actor_user_id TEXT, message TEXT,
      metadata ${json}, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id ${id}, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      file_key TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT,
      size_bytes INTEGER DEFAULT 0, storage_provider TEXT NOT NULL,
      uploaded_by TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS idempotency_records (
      idempotency_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_path TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_status INTEGER, response_body ${json},
      status TEXT DEFAULT 'processing', expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id ${id}, request_id TEXT NOT NULL, actor_user_id TEXT, event_type TEXT NOT NULL,
      entity_type TEXT, entity_id TEXT, before_state ${json}, after_state ${json},
      ip_address TEXT, metadata ${json}, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id ${id}, user_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
      entity_type TEXT, entity_id TEXT, read_at TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS notification_deliveries (
      id ${id}, reminder_id INTEGER REFERENCES reminders(id) ON DELETE RESTRICT,
      notification_id INTEGER REFERENCES notifications(id) ON DELETE RESTRICT,
      channel TEXT NOT NULL, provider TEXT, provider_message_id TEXT,
      status TEXT NOT NULL, sanitized_payload ${json}, error_message TEXT,
      attempted_at TEXT NOT NULL, delivered_at TEXT,
      CHECK (status IN ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED'))
    )`,
    `CREATE TABLE IF NOT EXISTS integration_credentials (
      provider TEXT PRIMARY KEY, encrypted_config TEXT NOT NULL,
      status TEXT DEFAULT 'active', updated_by TEXT, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS payment_gateway_transactions (
      id ${id}, provider TEXT NOT NULL, provider_order_id TEXT,
      provider_payment_id TEXT, provider_refund_id TEXT, direction TEXT DEFAULT 'payment',
      amount REAL NOT NULL, currency TEXT DEFAULT 'INR', status TEXT NOT NULL,
      trade_document_id INTEGER, customer_id INTEGER, idempotency_key TEXT,
      raw_response ${json}, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS webhook_events (
      id ${id}, provider TEXT NOT NULL, provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL, signature_valid INTEGER NOT NULL,
      payload ${json} NOT NULL, status TEXT DEFAULT 'received',
      processed_at TEXT, error_message TEXT, created_at TEXT NOT NULL,
      UNIQUE (provider, provider_event_id)
    )`,
    `CREATE TABLE IF NOT EXISTS settlements (
      id ${id}, provider TEXT NOT NULL, provider_settlement_id TEXT UNIQUE,
      amount REAL NOT NULL, fees REAL DEFAULT 0, tax REAL DEFAULT 0,
      status TEXT NOT NULL, settled_at TEXT, raw_response ${json}, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS number_sequences (
      sequence_key TEXT PRIMARY KEY, prefix TEXT NOT NULL, next_value INTEGER NOT NULL DEFAULT 1,
      padding INTEGER NOT NULL DEFAULT 6, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS organization_settings (
      setting_key TEXT PRIMARY KEY, setting_value ${json} NOT NULL,
      updated_by TEXT, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS feature_flags (
      flag_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      configuration ${json} NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL,
      CHECK (enabled IN (0, 1))
    )`,
    `CREATE TABLE IF NOT EXISTS payment_method_settings (
      method TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      requires_reference INTEGER NOT NULL DEFAULT 0,
      initial_status TEXT NOT NULL DEFAULT 'SUCCESS',
      display_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      CHECK (enabled IN (0, 1)),
      CHECK (requires_reference IN (0, 1)),
      CHECK (initial_status IN ('SUCCESS', 'PENDING', 'VERIFIED_CAPTURE_REQUIRED', 'CREDIT'))
    )`,
    `CREATE TABLE IF NOT EXISTS invoices (
      id ${id}, sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id),
      trade_document_id INTEGER UNIQUE REFERENCES trade_documents(id),
      customer_id INTEGER REFERENCES customers(id),
      invoice_number TEXT NOT NULL UNIQUE,
      invoice_status TEXT NOT NULL DEFAULT 'ISSUED',
      payment_status TEXT NOT NULL DEFAULT 'UNPAID',
      currency TEXT NOT NULL DEFAULT 'INR',
      subtotal_minor INTEGER NOT NULL DEFAULT 0,
      discount_total_minor INTEGER NOT NULL DEFAULT 0,
      taxable_total_minor INTEGER NOT NULL DEFAULT 0,
      cgst_total_minor INTEGER NOT NULL DEFAULT 0,
      sgst_total_minor INTEGER NOT NULL DEFAULT 0,
      igst_total_minor INTEGER NOT NULL DEFAULT 0,
      cess_total_minor INTEGER NOT NULL DEFAULT 0,
      round_off_minor INTEGER NOT NULL DEFAULT 0,
      grand_total_minor INTEGER NOT NULL,
      issued_at TEXT NOT NULL, due_date TEXT,
      seller_snapshot ${json} NOT NULL, customer_snapshot ${json} NOT NULL,
      delivery_snapshot ${json} NOT NULL, bank_snapshot ${json} NOT NULL,
      terms_snapshot TEXT, document_settings_snapshot ${json}, pdf_status TEXT NOT NULL DEFAULT 'PENDING',
      pdf_error TEXT, latest_pdf_version INTEGER NOT NULL DEFAULT 0,
      latest_pdf_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (invoice_status IN ('ISSUED', 'VOID', 'WRITTEN_OFF')),
      CHECK (payment_status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERPAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'VOID', 'WRITTEN_OFF')),
      CHECK (pdf_status IN ('PENDING', 'GENERATING', 'READY', 'FAILED')),
      CHECK (subtotal_minor >= 0 AND discount_total_minor >= 0 AND taxable_total_minor >= 0),
      CHECK (cgst_total_minor >= 0 AND sgst_total_minor >= 0 AND igst_total_minor >= 0 AND cess_total_minor >= 0),
      CHECK (grand_total_minor >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS invoice_items (
      id ${id}, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      product_id INTEGER REFERENCES products(id), variant_id INTEGER,
      description TEXT NOT NULL, hsn_sac TEXT, quantity TEXT NOT NULL,
      unit TEXT NOT NULL, rate_minor INTEGER NOT NULL,
      gross_minor INTEGER NOT NULL, discount_minor INTEGER NOT NULL DEFAULT 0,
      taxable_minor INTEGER NOT NULL, gst_rate TEXT NOT NULL,
      cgst_minor INTEGER NOT NULL DEFAULT 0, sgst_minor INTEGER NOT NULL DEFAULT 0,
      igst_minor INTEGER NOT NULL DEFAULT 0, cess_minor INTEGER NOT NULL DEFAULT 0,
      line_total_minor INTEGER NOT NULL, metadata ${json},
      CHECK (CAST(quantity AS REAL) > 0),
      CHECK (rate_minor >= 0 AND gross_minor >= 0 AND discount_minor >= 0),
      CHECK (taxable_minor >= 0 AND line_total_minor >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS payment_links (
      id ${id}, link_token_hash TEXT NOT NULL UNIQUE,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      customer_id INTEGER REFERENCES customers(id), amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR', provider TEXT NOT NULL DEFAULT 'razorpay',
      provider_link_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'ACTIVE',
      expires_at TEXT NOT NULL, usage_limit INTEGER NOT NULL DEFAULT 1, usage_count INTEGER NOT NULL DEFAULT 0,
      metadata ${json}, idempotency_key TEXT UNIQUE, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (amount_minor > 0),
      CHECK (status IN ('ACTIVE', 'PAID', 'EXPIRED', 'CANCELLED')),
      CHECK (usage_limit > 0 AND usage_count >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS fiscal_adjustments (
      id ${id}, adjustment_number TEXT NOT NULL UNIQUE,
      adjustment_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
      trade_document_id INTEGER REFERENCES trade_documents(id) ON DELETE RESTRICT,
      party_type TEXT NOT NULL, party_id INTEGER NOT NULL,
      warehouse_id INTEGER, currency TEXT NOT NULL DEFAULT 'INR', reason TEXT NOT NULL,
      subtotal_minor INTEGER NOT NULL DEFAULT 0, tax_total_minor INTEGER NOT NULL DEFAULT 0,
      grand_total_minor INTEGER NOT NULL, affects_stock INTEGER NOT NULL DEFAULT 0,
      party_snapshot ${json} NOT NULL, document_snapshot ${json} NOT NULL,
      created_by TEXT NOT NULL, issued_by TEXT, issued_at TEXT,
      cancelled_by TEXT, cancelled_at TEXT, cancellation_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (adjustment_type IN ('CREDIT_NOTE', 'DEBIT_NOTE')),
      CHECK (status IN ('DRAFT', 'ISSUED', 'CANCELLED')),
      CHECK (party_type IN ('customer', 'supplier')),
      CHECK (affects_stock IN (0, 1)),
      CHECK (subtotal_minor >= 0 AND tax_total_minor >= 0 AND grand_total_minor > 0)
    )`,
    `CREATE TABLE IF NOT EXISTS fiscal_adjustment_lines (
      id ${id}, adjustment_id INTEGER NOT NULL REFERENCES fiscal_adjustments(id) ON DELETE RESTRICT,
      product_id INTEGER, variant_id INTEGER, description TEXT NOT NULL,
      quantity TEXT NOT NULL, unit TEXT NOT NULL, rate_minor INTEGER NOT NULL,
      discount_minor INTEGER NOT NULL DEFAULT 0, taxable_minor INTEGER NOT NULL,
      tax_rate TEXT NOT NULL, tax_minor INTEGER NOT NULL DEFAULT 0,
      line_total_minor INTEGER NOT NULL, metadata ${json},
      CHECK (CAST(quantity AS REAL) > 0),
      CHECK (rate_minor >= 0 AND discount_minor >= 0 AND taxable_minor >= 0 AND tax_minor >= 0 AND line_total_minor > 0)
    )`,
    `CREATE TABLE IF NOT EXISTS party_ledger_entries (
      id ${id}, party_type TEXT NOT NULL, party_id INTEGER NOT NULL,
      fiscal_adjustment_id INTEGER NOT NULL REFERENCES fiscal_adjustments(id) ON DELETE RESTRICT,
      direction TEXT NOT NULL, amount_minor INTEGER NOT NULL,
      reference_number TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL,
      occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (fiscal_adjustment_id),
      CHECK (party_type IN ('customer', 'supplier')),
      CHECK (direction IN ('DEBIT', 'CREDIT')),
      CHECK (amount_minor > 0)
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id ${id}, payment_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER REFERENCES customers(id),
      direction TEXT NOT NULL DEFAULT 'IN',
      amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL, received_at TEXT, notes TEXT,
      created_by TEXT, idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (direction IN ('IN', 'OUT')),
      CHECK (amount_minor > 0),
      CHECK (status IN ('SUCCESS', 'PENDING', 'FAILED', 'CANCELLED'))
    )`,
    `CREATE TABLE IF NOT EXISTS payment_allocations (
      id ${id}, payment_id INTEGER REFERENCES payments(id) ON DELETE RESTRICT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      method TEXT NOT NULL, amount_minor INTEGER NOT NULL,
      reference_number TEXT, provider TEXT, provider_transaction_id TEXT,
      status TEXT NOT NULL, metadata ${json},
      created_by TEXT, confirmed_by TEXT, confirmed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (amount_minor > 0),
      CHECK (status IN ('SUCCESS', 'PENDING', 'FAILED', 'CANCELLED', 'REFUNDED')),
      UNIQUE (provider, provider_transaction_id)
    )`,
    `CREATE TABLE IF NOT EXISTS payment_attempts (
      id ${id}, allocation_id INTEGER REFERENCES payment_allocations(id) ON DELETE SET NULL,
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      provider TEXT NOT NULL, provider_order_id TEXT,
      provider_payment_id TEXT, provider_refund_id TEXT,
      amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL, signature_hash TEXT,
      request_payload ${json}, response_payload ${json},
      error_code TEXT, error_message TEXT, idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (amount_minor > 0),
      UNIQUE (provider, provider_payment_id),
      UNIQUE (provider, provider_refund_id)
    )`,
    `CREATE TABLE IF NOT EXISTS refunds (
      id ${id}, refund_number TEXT NOT NULL UNIQUE,
      allocation_id INTEGER NOT NULL REFERENCES payment_allocations(id) ON DELETE RESTRICT,
      payment_id INTEGER REFERENCES payments(id) ON DELETE RESTRICT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      amount_minor INTEGER NOT NULL, status TEXT NOT NULL,
      method TEXT NOT NULL, provider_refund_id TEXT,
      reason TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      CHECK (amount_minor > 0),
      CHECK (status IN ('SUCCESS', 'PENDING', 'FAILED')),
      UNIQUE (method, provider_refund_id)
    )`,
    `CREATE TABLE IF NOT EXISTS customer_ledger_entries (
      id ${id}, customer_id INTEGER NOT NULL REFERENCES customers(id),
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
      payment_id INTEGER REFERENCES payments(id) ON DELETE RESTRICT,
      refund_id INTEGER REFERENCES refunds(id) ON DELETE RESTRICT,
      entry_type TEXT NOT NULL, direction TEXT NOT NULL,
      amount_minor INTEGER NOT NULL, running_balance_minor INTEGER NOT NULL,
      reference_number TEXT, description TEXT, created_by TEXT,
      occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
      CHECK (entry_type IN ('INVOICE', 'PAYMENT', 'REFUND', 'WRITE_OFF', 'LEGACY_IMPORT')),
      CHECK (direction IN ('DEBIT', 'CREDIT')),
      CHECK (amount_minor > 0)
    )`,
    `CREATE TABLE IF NOT EXISTS customer_store_credit_accounts (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      balance_minor INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      CHECK (balance_minor >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS invoice_pdf_versions (
      id ${id}, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL, storage_provider TEXT NOT NULL,
      storage_key TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/pdf',
      size_bytes INTEGER NOT NULL DEFAULT 0, checksum_sha256 TEXT NOT NULL,
      generated_by TEXT, created_at TEXT NOT NULL,
      UNIQUE (invoice_id, version), UNIQUE (storage_provider, storage_key)
    )`,
    `CREATE TABLE IF NOT EXISTS document_generation_jobs (
      id ${id}, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      organization_id TEXT NOT NULL, job_type TEXT NOT NULL DEFAULT 'invoice.pdf.generate',
      status TEXT NOT NULL DEFAULT 'PENDING', attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, payload ${json} NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, available_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_customer_date ON invoices(customer_id, issued_at)`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_payment_status ON invoices(payment_status, issued_at)`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payment_allocations_invoice ON payment_allocations(invoice_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_customer_date ON payments(customer_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer_date ON customer_ledger_entries(customer_id, occurred_at)`,
    `CREATE INDEX IF NOT EXISTS idx_journals_date ON journals(journal_date, id)`,
    `CREATE INDEX IF NOT EXISTS idx_journal_entries_account ON journal_entries(account_id, journal_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bank_transactions_status_date ON bank_transactions(reconciliation_status, transaction_date)`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_date_status ON expenses(expense_date, status)`,
    `CREATE INDEX IF NOT EXISTS idx_payment_links_invoice ON payment_links(invoice_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_schedule ON reminders(status, scheduled_at)`,
    `CREATE INDEX IF NOT EXISTS idx_project_entries_project ON project_entries(project_id, occurred_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_entries_source ON project_entries(project_id, entry_type, source_type, source_id)`,
    `CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(status, next_run_at)`,
    `CREATE INDEX IF NOT EXISTS idx_subscription_runs_schedule ON subscription_runs(status, scheduled_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_document_source ON compliance_documents(compliance_type, invoice_id) WHERE invoice_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_compliance_documents_status ON compliance_documents(compliance_type, status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_gst_returns_period ON gst_return_periods(return_type, period, status)`,
    `CREATE INDEX IF NOT EXISTS idx_gst_reconciliation_return ON gst_reconciliation_rows(return_id, match_status)`,
    `CREATE INDEX IF NOT EXISTS idx_refunds_invoice ON refunds(invoice_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_document_jobs_status ON document_generation_jobs(status, available_at)`,
    `CREATE INDEX IF NOT EXISTS idx_document_links_source ON document_links(source_entity_type, source_entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_document_links_target ON document_links(target_entity_type, target_entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fiscal_adjustments_party_date ON fiscal_adjustments(party_type, party_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_fiscal_adjustments_invoice ON fiscal_adjustments(invoice_id, status)`,
    `CREATE TABLE IF NOT EXISTS ai_conversations (
      id ${id}, user_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ai_messages (
      id ${id}, conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, metadata ${json}, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ai_tool_calls (
      id ${id}, conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      message_id INTEGER REFERENCES ai_messages(id) ON DELETE SET NULL,
      tool_name TEXT NOT NULL, arguments ${json}, result_summary TEXT,
      status TEXT DEFAULT 'completed', created_by TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ai_action_proposals (
      id ${id}, conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE SET NULL,
      message_id INTEGER REFERENCES ai_messages(id) ON DELETE SET NULL,
      action_type TEXT NOT NULL, title TEXT NOT NULL, reason TEXT, payload ${json} NOT NULL,
      status TEXT DEFAULT 'pending', proposed_by TEXT, approved_by TEXT, rejected_by TEXT,
      approved_at TEXT, rejected_at TEXT, rejection_reason TEXT,
      execution_result ${json}, execution_error TEXT, last_attempt_at TEXT,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
      id ${id}, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT,
      source_type TEXT DEFAULT 'manual', source_reference TEXT,
      status TEXT DEFAULT 'active', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ai_usage_records (
      id ${id}, conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE SET NULL,
      user_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      latency_ms INTEGER DEFAULT 0, fallback_used INTEGER DEFAULT 0,
      error_code TEXT, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS barcode_assignments (
      id ${id}, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      variant_id INTEGER REFERENCES product_variants(id) ON DELETE RESTRICT,
      barcode_value TEXT NOT NULL UNIQUE, barcode_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ASSIGNED', source TEXT NOT NULL DEFAULT 'AUTO',
      is_primary INTEGER NOT NULL DEFAULT 1, created_by TEXT,
      assigned_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
      last_printed_at TEXT, print_count INTEGER NOT NULL DEFAULT 0,
      validation_message TEXT,
      CHECK (status IN ('ASSIGNED', 'INVALID', 'DUPLICATE', 'ARCHIVED', 'PENDING')),
      CHECK (source IN ('AUTO', 'MANUAL', 'REGENERATED', 'LEGACY_IMPORT', 'SCANNER')),
      CHECK (is_primary IN (0, 1)),
      CHECK (print_count >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS barcode_templates (
      id ${id}, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'product',
      configuration ${json} NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (is_default IN (0, 1)),
      CHECK (status IN ('active', 'archived'))
    )`,
    `CREATE TABLE IF NOT EXISTS label_layouts (
      id ${id}, name TEXT NOT NULL, paper_type TEXT NOT NULL,
      page_width_mm REAL NOT NULL, page_height_mm REAL NOT NULL,
      label_width_mm REAL NOT NULL, label_height_mm REAL NOT NULL,
      rows INTEGER NOT NULL, columns INTEGER NOT NULL,
      margins ${json} NOT NULL, gaps ${json} NOT NULL,
      orientation TEXT NOT NULL DEFAULT 'portrait',
      printer_type TEXT NOT NULL DEFAULT 'laser',
      is_default INTEGER NOT NULL DEFAULT 0, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (page_width_mm > 0 AND page_height_mm > 0),
      CHECK (label_width_mm > 0 AND label_height_mm > 0),
      CHECK (rows > 0 AND columns > 0),
      CHECK (orientation IN ('portrait', 'landscape')),
      CHECK (is_default IN (0, 1))
    )`,
    `CREATE TABLE IF NOT EXISTS barcode_print_jobs (
      id ${id}, job_number TEXT NOT NULL UNIQUE,
      template_id INTEGER NOT NULL REFERENCES barcode_templates(id),
      layout_id INTEGER NOT NULL REFERENCES label_layouts(id),
      status TEXT NOT NULL DEFAULT 'PENDING', output_type TEXT NOT NULL DEFAULT 'PDF',
      printer_type TEXT NOT NULL DEFAULT 'browser', item_count INTEGER NOT NULL DEFAULT 0,
      label_count INTEGER NOT NULL DEFAULT 0, copies INTEGER NOT NULL DEFAULT 1,
      starting_position INTEGER NOT NULL DEFAULT 1,
      storage_provider TEXT, output_file_key TEXT, output_content_type TEXT,
      output_size_bytes INTEGER, error_message TEXT, requested_by TEXT,
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
      CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
      CHECK (output_type IN ('PDF', 'ZIP')),
      CHECK (item_count >= 0 AND label_count >= 0 AND copies > 0),
      CHECK (starting_position > 0)
    )`,
    `CREATE TABLE IF NOT EXISTS barcode_print_job_items (
      id ${id}, print_job_id INTEGER NOT NULL REFERENCES barcode_print_jobs(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      variant_id INTEGER REFERENCES product_variants(id),
      barcode_assignment_id INTEGER NOT NULL REFERENCES barcode_assignments(id),
      quantity INTEGER NOT NULL, snapshot ${json} NOT NULL,
      CHECK (quantity > 0)
    )`,
    `CREATE TABLE IF NOT EXISTS barcode_scan_events (
      id ${id}, barcode_value TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id), variant_id INTEGER REFERENCES product_variants(id),
      user_id TEXT, source TEXT NOT NULL DEFAULT 'HID', action TEXT NOT NULL DEFAULT 'RESOLVE',
      device TEXT, status TEXT NOT NULL, metadata ${json}, created_at TEXT NOT NULL,
      CHECK (source IN ('HID', 'BLUETOOTH', 'CAMERA', 'MANUAL', 'POS')),
      CHECK (status IN ('RESOLVED', 'UNKNOWN', 'INVALID', 'OUT_OF_STOCK'))
    )`,
    `CREATE TABLE IF NOT EXISTS barcode_generation_jobs (
      id ${id}, product_id INTEGER REFERENCES products(id), variant_id INTEGER REFERENCES product_variants(id),
      status TEXT NOT NULL DEFAULT 'PENDING', attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_barcode_primary_product
      ON barcode_assignments(product_id)
      WHERE is_primary = 1 AND variant_id IS NULL AND archived_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_barcode_primary_variant
      ON barcode_assignments(variant_id)
      WHERE is_primary = 1 AND variant_id IS NOT NULL AND archived_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_barcode_assignments_lookup
      ON barcode_assignments(barcode_value, status)`,
    `CREATE INDEX IF NOT EXISTS idx_barcode_print_jobs_status
      ON barcode_print_jobs(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_barcode_print_items_job
      ON barcode_print_job_items(print_job_id)`,
    `CREATE INDEX IF NOT EXISTS idx_barcode_scans_value_date
      ON barcode_scan_events(barcode_value, created_at)`
  ];
}

async function seedSettingsFoundationDefaults(tx) {
  const timestamp = now();
  const defaults = [
    ['frontend_modules', 1],
    ['settings_namespaces', 1],
    ['navigation_v2', 0],
    ['trade_workspaces', 0],
    ['document_engine_v2', 0],
    ['finance_v2', 0],
    ['reminders_v2', 0],
    ['projects_v2', 0],
    ['notifications_v2', 0]
  ];
  for (const [key, enabled] of defaults) {
    await tx.run(
      `INSERT INTO feature_flags
        (flag_key, enabled, configuration, updated_by, updated_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (flag_key) DO NOTHING`,
      [key, enabled, JSON.stringify({}), timestamp]
    );
  }
}

async function seedFinanceOperationsDefaults(tx) {
  const timestamp = now();
  for (const key of ['finance_v2', 'reminders_v2', 'projects_v2']) {
    await tx.run(
      `INSERT INTO feature_flags (flag_key, enabled, configuration, updated_by, updated_at)
       VALUES (?, 0, ?, NULL, ?) ON CONFLICT (flag_key) DO NOTHING`,
      [key, JSON.stringify({}), timestamp]
    );
  }
  const accounts = [
    ['1000', 'Cash on Hand', 'asset'],
    ['1100', 'Bank Accounts', 'asset'],
    ['1200', 'Accounts Receivable', 'asset'],
    ['2000', 'Accounts Payable', 'liability'],
    ['2100', 'GST Payable', 'liability'],
    ['4000', 'Sales Revenue', 'income'],
    ['5000', 'Cost of Goods Sold', 'expense'],
    ['6000', 'General Expenses', 'expense'],
    ['3000', 'Owner Equity', 'equity']
  ];
  for (const [code, name, type] of accounts) {
    await tx.run(
      `INSERT INTO accounts
        (code, name, account_type, opening_balance, opening_balance_minor, currency,
         is_archived, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 'INR', 0, ?, ?)
       ON CONFLICT (code) DO NOTHING`,
      [code, name, type, timestamp, timestamp]
    );
  }
  for (const [key, prefix] of [['journal', 'JV'], ['expense', 'EXP'], ['project', 'PRJ']]) {
    await tx.run(
      `INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at)
       VALUES (?, ?, 1, 6, ?) ON CONFLICT (sequence_key) DO NOTHING`,
      [key, prefix, timestamp]
    );
  }
  await backfillFinanceJournals(tx);
}

async function seedSubscriptionsComplianceDefaults(tx) {
  for (const key of ['subscriptions_v2', 'compliance_v2']) {
    await tx.run(
      `INSERT INTO feature_flags (flag_key, enabled, configuration, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT (flag_key) DO NOTHING`,
      [key, JSON.stringify({}), now()]
    );
  }
  for (const [key, prefix] of [['subscription', 'SUB'], ['compliance_einvoice', 'EINV'], ['compliance_eway', 'EWB']]) {
    await tx.run(
      `INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at)
       VALUES (?, ?, 1, 6, ?) ON CONFLICT (sequence_key) DO NOTHING`,
      [key, prefix, now()]
    );
  }
}

async function backfillFinanceJournals(tx) {
  const accountRows = await tx.all(`SELECT id, code FROM accounts WHERE code IN ('1000','1100','1200','2000','2100','4000','5000')`);
  const accounts = Object.fromEntries(accountRows.map(row => [row.code, row.id]));
  if (!accounts['1200'] || !accounts['4000']) return;
  const invoices = await tx.all(`SELECT * FROM invoices WHERE invoice_status = 'ISSUED' ORDER BY id`);
  for (const invoice of invoices) {
    const taxMinor = Number(invoice.cgst_total_minor || 0) + Number(invoice.sgst_total_minor || 0)
      + Number(invoice.igst_total_minor || 0) + Number(invoice.cess_total_minor || 0);
    await seedFinanceJournal(tx, {
      journalType: 'INVOICE', sourceType: 'invoice', sourceId: invoice.id,
      date: String(invoice.issued_at).slice(0, 10), reference: invoice.invoice_number,
      description: `Migrated invoice ${invoice.invoice_number}.`, actor: 'MIGRATION',
      entries: [
        [accounts['1200'], Number(invoice.grand_total_minor), 0, 'customer', invoice.customer_id],
        [accounts['4000'], 0, Number(invoice.grand_total_minor) - taxMinor, null, null],
        ...(taxMinor > 0 && accounts['2100'] ? [[accounts['2100'], 0, taxMinor, null, null]] : [])
      ]
    });
  }
  const allocations = await tx.all(
    `SELECT pa.*, p.payment_number FROM payment_allocations pa
      LEFT JOIN payments p ON p.id = pa.payment_id WHERE pa.status = 'SUCCESS' ORDER BY pa.id`
  );
  for (const allocation of allocations) {
    const cashAccount = allocation.method === 'CASH' ? accounts['1000'] : accounts['1100'];
    if (!cashAccount) continue;
    await seedFinanceJournal(tx, {
      journalType: 'RECEIPT', sourceType: 'payment_allocation', sourceId: allocation.id,
      date: String(allocation.confirmed_at || allocation.created_at).slice(0, 10),
      reference: allocation.payment_number, description: 'Migrated payment allocation.', actor: 'MIGRATION',
      entries: [[cashAccount, Number(allocation.amount_minor), 0, null, null], [accounts['1200'], 0, Number(allocation.amount_minor), null, null]]
    });
  }
  const refunds = await tx.all(
    `SELECT r.*, pa.method FROM refunds r JOIN payment_allocations pa ON pa.id = r.allocation_id
      WHERE r.status = 'SUCCESS' ORDER BY r.id`
  );
  for (const refund of refunds) {
    const cashAccount = refund.method === 'CASH' ? accounts['1000'] : accounts['1100'];
    if (!cashAccount) continue;
    await seedFinanceJournal(tx, {
      journalType: 'REFUND', sourceType: 'refund', sourceId: refund.id,
      date: String(refund.created_at).slice(0, 10), reference: refund.refund_number,
      description: 'Migrated refund.', actor: 'MIGRATION',
      entries: [[accounts['1200'], Number(refund.amount_minor), 0, null, null], [cashAccount, 0, Number(refund.amount_minor), null, null]]
    });
  }
  const adjustments = await tx.all(`SELECT * FROM fiscal_adjustments WHERE status = 'ISSUED' ORDER BY id`);
  for (const adjustment of adjustments) {
    const credit = adjustment.adjustment_type === 'CREDIT_NOTE';
    const entries = credit
      ? [
        [accounts['4000'], Number(adjustment.subtotal_minor), 0, null, null],
        ...(Number(adjustment.tax_total_minor) > 0 && accounts['2100'] ? [[accounts['2100'], Number(adjustment.tax_total_minor), 0, null, null]] : []),
        [accounts['1200'], 0, Number(adjustment.grand_total_minor), 'customer', adjustment.party_id]
      ]
      : [[accounts['2000'], Number(adjustment.grand_total_minor), 0, 'supplier', adjustment.party_id], [accounts['5000'], 0, Number(adjustment.grand_total_minor), null, null]];
    await seedFinanceJournal(tx, {
      journalType: adjustment.adjustment_type, sourceType: 'fiscal_adjustment', sourceId: adjustment.id,
      date: String(adjustment.issued_at || adjustment.created_at).slice(0, 10),
      reference: adjustment.adjustment_number, description: adjustment.reason, actor: 'MIGRATION', entries
    });
  }
}

async function seedFinanceJournal(tx, input) {
  const existing = await tx.one(
    'SELECT id FROM journals WHERE source_type = ? AND source_id = ? AND journal_type = ?',
    [input.sourceType, String(input.sourceId), input.journalType]
  );
  if (existing) return existing.id;
  const total = input.entries.reduce((sum, entry) => sum + Number(entry[1] || 0), 0);
  const credit = input.entries.reduce((sum, entry) => sum + Number(entry[2] || 0), 0);
  if (total <= 0 || total !== credit || input.entries.some(entry => !entry[0])) return null;
  const timestamp = now();
  const journalNo = `MIG-JV-${input.journalType}-${input.sourceId}`;
  const inserted = await tx.run(
    `INSERT INTO journals
      (journal_no, journal_type, journal_date, reference, description, source_type,
       source_id, status, total_debit_minor, total_credit_minor, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?)${tx.dialect === 'postgres' ? ' RETURNING id' : ''}`,
    [journalNo, input.journalType, input.date, input.reference || null, input.description || null,
      input.sourceType, String(input.sourceId), total, credit, input.actor, timestamp]
  );
  const journalId = inserted.id || inserted.rows?.[0]?.id;
  for (const [accountId, debitMinor, creditMinor, partyType, partyId] of input.entries) {
    await tx.run(
      `INSERT INTO journal_entries
        (journal_id, account_id, debit_minor, credit_minor, party_type, party_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [journalId, accountId, debitMinor, creditMinor, partyType, partyId || null, timestamp]
    );
  }
  return journalId;
}

async function seedDocumentEngineDefaults(tx) {
  const timestamp = now();
  await tx.run(
    `INSERT INTO feature_flags (flag_key, enabled, configuration, updated_by, updated_at)
     VALUES ('document_engine_v2', 0, ?, NULL, ?)
     ON CONFLICT (flag_key) DO NOTHING`,
    [JSON.stringify({}), timestamp]
  );
  for (const [key, prefix] of [['pro_forma_invoice', 'PI'], ['credit_note', 'CN'], ['debit_note', 'DN']]) {
    await tx.run(
      `INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at)
       VALUES (?, ?, 1, 6, ?) ON CONFLICT (sequence_key) DO NOTHING`,
      [key, prefix, timestamp]
    );
  }
  const existing = await tx.one(`SELECT id FROM document_templates WHERE document_type = 'invoice' AND is_default = 1`);
  if (!existing) {
    await tx.run(
      `INSERT INTO document_templates
        (name, document_type, format, configuration, is_default, status, created_by, created_at, updated_at)
       VALUES ('GST Invoice A4', 'invoice', 'A4', ?, 1, 'active', NULL, ?, ?)`,
      [JSON.stringify({ use_semantic_html: true, repeat_table_header: true, print_background: true }), timestamp, timestamp]
    );
  }
}

async function seedBarcodeLabelDefaults(tx) {
  const timestamp = now();
  const settings = {
    enabled: true,
    auto_generate: true,
    default_type: 'CODE128',
    assignment_level: 'product',
    prefix: 'INV',
    suffix: '',
    sequence_length: 9,
    pattern: '{PREFIX}{SEQUENCE}{SUFFIX}',
    prevent_duplicates: true,
    allow_manual: true,
    allow_regeneration: true,
    default_label_quantity: 1,
    scanner: {
      mode: 'HID',
      prefix: '',
      suffix: '',
      termination_key: 'Enter',
      duplicate_delay_ms: 750,
      sound: true,
      auto_add_to_pos: true
    }
  };
  await tx.run(
    `INSERT INTO organization_settings (setting_key, setting_value, updated_by, updated_at)
     VALUES ('barcode.settings', ?, NULL, ?)
     ON CONFLICT (setting_key) DO NOTHING`,
    [JSON.stringify(settings), timestamp]
  );
  await tx.run(
    `INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at)
     VALUES ('barcode:default', 'INV', 1, 9, ?)
     ON CONFLICT (sequence_key) DO NOTHING`,
    [timestamp]
  );
  const template = await tx.one('SELECT id FROM barcode_templates WHERE is_default = 1 AND status = ?', ['active']);
  if (!template) {
    await tx.run(
      `INSERT INTO barcode_templates
        (name, category, configuration, is_default, status, created_by, created_at, updated_at)
       VALUES ('Retail MRP', 'retail', ?, 1, 'active', NULL, ?, ?)`,
      [JSON.stringify({
        show_company: true, show_product: true, show_variant: true, show_sku: true,
        show_barcode_number: true, show_mrp: true, show_selling_price: true,
        show_hsn: false, show_batch: false, show_expiry: false,
        barcode_height_mm: 11, font_size_pt: 8, alignment: 'center', border: true
      }), timestamp, timestamp]
    );
  }
  const layout = await tx.one('SELECT id FROM label_layouts WHERE is_default = 1');
  if (!layout) {
    await tx.run(
      `INSERT INTO label_layouts
        (name, paper_type, page_width_mm, page_height_mm, label_width_mm, label_height_mm,
         rows, columns, margins, gaps, orientation, printer_type, is_default,
         created_by, created_at, updated_at)
       VALUES ('A4 40 labels', 'A4', 210, 297, 48, 25, 10, 4, ?, ?, 'portrait', 'laser', 1, NULL, ?, ?)`,
      [JSON.stringify({ top: 12, right: 6, bottom: 12, left: 6 }),
        JSON.stringify({ horizontal: 3, vertical: 1 }), timestamp, timestamp]
    );
    await tx.run(
      `INSERT INTO label_layouts
        (name, paper_type, page_width_mm, page_height_mm, label_width_mm, label_height_mm,
         rows, columns, margins, gaps, orientation, printer_type, is_default,
         created_by, created_at, updated_at)
       VALUES ('Thermal 50 x 25 mm', 'CUSTOM', 50, 25, 50, 25, 1, 1, ?, ?, 'portrait', 'thermal', 0, NULL, ?, ?)`,
      [JSON.stringify({ top: 0, right: 0, bottom: 0, left: 0 }),
        JSON.stringify({ horizontal: 0, vertical: 0 }), timestamp, timestamp]
    );
  }
}

async function backfillBarcodeAssignments(tx) {
  const products = await tx.all('SELECT id, sku, barcode FROM products ORDER BY id');
  for (const product of products) {
    const value = product.barcode || await nextBackfillBarcode(tx);
    const exists = await tx.one('SELECT id FROM barcode_assignments WHERE barcode_value = ?', [value]);
    if (exists) continue;
    if (!product.barcode) await tx.run('UPDATE products SET barcode = ?, updated_at = ? WHERE id = ?', [value, now(), product.id]);
    await tx.run(
      `INSERT INTO barcode_assignments
        (product_id, variant_id, barcode_value, barcode_type, status, source, is_primary,
         created_by, assigned_at, updated_at)
       VALUES (?, NULL, ?, 'CODE128', 'ASSIGNED', ?, 1, NULL, ?, ?)`,
      [product.id, value, product.barcode ? 'LEGACY_IMPORT' : 'AUTO', now(), now()]
    );
  }
  const variants = await tx.all('SELECT id, product_id, sku, barcode FROM product_variants ORDER BY id');
  for (const variant of variants) {
    const value = variant.barcode || await nextBackfillBarcode(tx);
    const exists = await tx.one('SELECT id FROM barcode_assignments WHERE barcode_value = ?', [value]);
    if (exists) continue;
    if (!variant.barcode) await tx.run('UPDATE product_variants SET barcode = ?, updated_at = ? WHERE id = ?', [value, now(), variant.id]);
    await tx.run(
      `INSERT INTO barcode_assignments
        (product_id, variant_id, barcode_value, barcode_type, status, source, is_primary,
         created_by, assigned_at, updated_at)
       VALUES (?, ?, ?, 'CODE128', 'ASSIGNED', ?, 1, NULL, ?, ?)`,
      [variant.product_id, variant.id, value, variant.barcode ? 'LEGACY_IMPORT' : 'AUTO', now(), now()]
    );
  }
}

async function nextBackfillBarcode(tx) {
  let sequence = await tx.one('SELECT next_value, prefix, padding FROM number_sequences WHERE sequence_key = ?', ['barcode:default']);
  if (!sequence) {
    await tx.run(
      `INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at)
       VALUES ('barcode:default', 'INV', 1, 9, ?)`,
      [now()]
    );
    sequence = { next_value: 1, prefix: 'INV', padding: 9 };
  }
  const value = `${sequence.prefix || 'INV'}${String(sequence.next_value).padStart(Number(sequence.padding || 9), '0')}`;
  await tx.run(
    'UPDATE number_sequences SET next_value = ?, updated_at = ? WHERE sequence_key = ?',
    [Number(sequence.next_value) + 1, now(), 'barcode:default']
  );
  return value;
}

async function seedPaymentMethods(tx) {
  const methods = [
    ['CASH', 'Cash', 1, 0, 'SUCCESS', 10],
    ['CARD', 'Terminal Card', 1, 1, 'SUCCESS', 20],
    ['UPI', 'UPI', 1, 1, 'SUCCESS', 30],
    ['BANK_TRANSFER', 'Bank Transfer', 1, 1, 'SUCCESS', 40],
    ['CHEQUE', 'Cheque', 1, 1, 'PENDING', 50],
    ['RAZORPAY', 'Razorpay', 0, 1, 'VERIFIED_CAPTURE_REQUIRED', 60],
    ['STORE_CREDIT', 'Store Credit', 1, 0, 'SUCCESS', 70],
    ['CUSTOMER_CREDIT', 'Pay Later', 1, 0, 'CREDIT', 80],
    ['OTHER', 'Other', 1, 1, 'PENDING', 90]
  ];
  for (const method of methods) {
    await tx.run(
      `INSERT INTO payment_method_settings
        (method, label, enabled, requires_reference, initial_status, display_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (method) DO NOTHING`,
      [...method, now()]
    );
  }
}

async function backfillInvoicePayments(tx) {
  const sales = await tx.all(
    `SELECT s.*, td.id AS trade_document_id
       FROM sales s
       LEFT JOIN trade_documents td
         ON td.document_type = 'invoice' AND td.document_no = s.invoice_no
      WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.sale_id = s.id)
      ORDER BY s.id`
  );
  for (const sale of sales) {
    const totalMinor = Math.max(0, Math.round(Number(sale.total || 0) * 100));
    const subtotalMinor = Math.max(0, Math.round(Number(sale.subtotal || 0) * 100));
    const discountMinor = Math.max(0, Math.round(Number(sale.discount || 0) * 100));
    const taxMinor = Math.max(0, Math.round(Number(sale.tax_amount || 0) * 100));
    const paid = String(sale.payment_status || '').toLowerCase() === 'completed';
    const timestamp = sale.sale_date || now();
    const invoiceInsert = await tx.run(
      `INSERT INTO invoices
        (sale_id, trade_document_id, customer_id, invoice_number, invoice_status, payment_status,
         subtotal_minor, discount_total_minor, taxable_total_minor, cgst_total_minor,
         sgst_total_minor, igst_total_minor, grand_total_minor, issued_at,
         seller_snapshot, customer_snapshot, delivery_snapshot, bank_snapshot, terms_snapshot,
         pdf_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ISSUED', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      [
        sale.id, sale.trade_document_id || null, sale.customer_id || null, sale.invoice_no,
        paid ? 'PAID' : 'UNPAID', subtotalMinor, discountMinor,
        Math.max(0, subtotalMinor - discountMinor), taxMinor, totalMinor, timestamp,
        JSON.stringify({ name: 'Inventia', legacy_import: true }),
        JSON.stringify({ name: sale.customer_id ? 'Legacy customer' : 'Walk-in Customer', legacy_import: true }),
        JSON.stringify({}), JSON.stringify({}), 'Imported from the legacy sale record.', timestamp, timestamp
      ]
    );
    const invoiceId = invoiceInsert.id || invoiceInsert.rows?.[0]?.id;
    const saleItems = await tx.all(
      `SELECT si.*, p.name, p.uom, pc.hsn_code, COALESCE(pc.gst_rate, 0) AS gst_rate
         FROM sale_items si
         LEFT JOIN products p ON p.id = si.product_id
         LEFT JOIN product_commerce pc ON pc.product_id = si.product_id
        WHERE si.sale_id = ? ORDER BY si.id`,
      [sale.id]
    );
    for (const item of saleItems) {
      const rateMinor = Math.max(0, Math.round(Number(item.unit_price || 0) * 100));
      const lineMinor = Math.max(0, Math.round(Number(item.total_price || 0) * 100));
      await tx.run(
        `INSERT INTO invoice_items
          (invoice_id, product_id, description, hsn_sac, quantity, unit, rate_minor,
           gross_minor, discount_minor, taxable_minor, gst_rate, cgst_minor, sgst_minor,
           igst_minor, line_total_minor, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, ?, ?, ?)`,
        [
          invoiceId, item.product_id, item.name || `Product ${item.product_id}`, item.hsn_code || '',
          String(item.quantity), item.uom || 'piece', rateMinor,
          Math.max(0, Math.round(Number(item.quantity || 0) * rateMinor)),
          Math.max(0, lineMinor - Math.round(lineMinor * Number(item.gst_rate || 0) / (100 + Number(item.gst_rate || 0)))),
          String(item.gst_rate || 0), taxMinor, lineMinor, JSON.stringify({ legacy_import: true })
        ]
      );
    }
    if (paid && totalMinor > 0) {
      const paymentNumber = `LEGACY-PAY-${sale.id}`;
      const paymentInsert = await tx.run(
        `INSERT INTO payments
          (payment_number, customer_id, direction, amount_minor, currency, status,
           received_at, notes, created_by, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'IN', ?, 'INR', 'SUCCESS', ?, ?, ?, ?, ?, ?)`,
        [
          paymentNumber, sale.customer_id || null, totalMinor, timestamp,
          'Imported from completed legacy sale.', sale.user_id || null,
          `legacy-sale:${sale.id}`, timestamp, timestamp
        ]
      );
      const paymentId = paymentInsert.id || paymentInsert.rows?.[0]?.id;
      await tx.run(
        `INSERT INTO payment_allocations
          (payment_id, invoice_id, method, amount_minor, reference_number, status,
           metadata, created_by, confirmed_by, confirmed_at, created_at, updated_at)
         VALUES (?, ?, 'LEGACY_IMPORT', ?, ?, 'SUCCESS', ?, ?, ?, ?, ?, ?)`,
        [
          paymentId, invoiceId, totalMinor, paymentNumber, JSON.stringify({ legacy_import: true }),
          sale.user_id || null, sale.user_id || null, timestamp, timestamp, timestamp
        ]
      );
    } else if (sale.customer_id && totalMinor > 0) {
      const current = await tx.one(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END), 0) AS balance
           FROM customer_ledger_entries WHERE customer_id = ?`,
        [sale.customer_id]
      );
      await tx.run(
        `INSERT INTO customer_ledger_entries
          (customer_id, invoice_id, entry_type, direction, amount_minor, running_balance_minor,
           reference_number, description, created_by, occurred_at, created_at)
         VALUES (?, ?, 'LEGACY_IMPORT', 'DEBIT', ?, ?, ?, ?, ?, ?, ?)`,
        [
          sale.customer_id, invoiceId, totalMinor, Number(current?.balance || 0) + totalMinor,
          sale.invoice_no, 'Outstanding balance imported from legacy credit sale.',
          sale.user_id || null, timestamp, timestamp
        ]
      );
    }
  }
}

function encryptTenantConfig(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decryptTenantConfig(value) {
  const input = Buffer.from(value, 'base64url');
  const iv = input.subarray(0, 12);
  const tag = input.subarray(12, 28);
  const encrypted = input.subarray(28);
  let lastError;
  for (const key of decryptionKeys()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function encryptIntegrationConfig(value) {
  return encryptTenantConfig(value);
}

export function decryptIntegrationConfig(value) {
  return decryptTenantConfig(value);
}

function encryptionKey() {
  const secret = process.env.TENANT_MASTER_KEY || process.env.JWT_SECRET || 'inventia-local-tenant-encryption-key';
  if (process.env.NODE_ENV === 'production' && secret === 'inventia-local-tenant-encryption-key') {
    throw new Error('TENANT_MASTER_KEY is required in production.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function decryptionKeys() {
  const keys = [encryptionKey()];
  if (process.env.NODE_ENV !== 'production') {
    const localFallback = crypto.createHash('sha256').update('inventia-local-tenant-encryption-key').digest();
    if (!keys[0].equals(localFallback)) keys.push(localFallback);
  }
  return keys;
}

function toPostgresParams(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function withSqliteLock(key, work) {
  const previous = sqliteLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  sqliteLocks.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (sqliteLocks.get(key) === queued) sqliteLocks.delete(key);
  }
}

function rolePermissions(role) {
  const map = {
    admin: ['*'],
    manager: ['dashboard.read', 'products.*', 'inventory.*', 'trade.*', 'parties.*', 'payments.*', 'approvals.*', 'ai.*', 'barcode.*', 'finance.*', 'projects.*', 'reminders.*', 'subscriptions.*', 'compliance.read', 'compliance.prepare', 'compliance.file', 'reports.read'],
    cashier: [
      'dashboard.read', 'products.read', 'inventory.read', 'trade.sales.*',
      'parties.customers.*', 'payments.create', 'ai.read',
      'barcode.view', 'barcode.scan', 'barcode.print', 'barcode.download', 'barcode.history.view'
    ],
    warehouse_staff: [
      'dashboard.read', 'products.read', 'inventory.*', 'trade.purchases.receive',
      'trade.read', 'ai.read', 'barcode.view', 'barcode.generate', 'barcode.assign',
      'barcode.print', 'barcode.download', 'barcode.scan', 'barcode.history.view'
    ]
  };
  return map[role] || [];
}

function now() {
  return new Date().toISOString();
}

function platformError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_SLUG,
  DEFAULT_ORGANIZATION_NAME,
  rolePermissions
};
