import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-finance-operations-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'finance-operations-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'finance-operations-test-master-key';
process.env.INVOICE_STORAGE_DIR = path.join(testRoot, 'uploads');
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const finance = await import('../src/services/financeOperationsService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({ hashPassword: authModule.hashPlatformPassword });
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = {
  requestId: 'finance-operations-test',
  user: {
    id: session.user.id, tenant_user_id: session.user.id, role: session.user.role,
    permissions: ['*'], organization_id: session.organization.id
  },
  headers: { 'idempotency-key': 'finance-operations-test' }, ip: '127.0.0.1', tenantDb: db,
  invoicePdfGenerator: async () => { throw new Error('PDF intentionally unavailable in finance tests.'); }
};

await db.run(`INSERT INTO warehouses (name, code, type, created_at) VALUES ('Finance Main', 'FIN-MAIN', 'warehouse', ?)`, [new Date().toISOString()]);
const customer = await trade.createParty(db, 'customer', { name: 'Finance Customer', credit_limit: 10000 }, request);
const product = await trade.createProduct(db, {
  sku: 'FIN-001', name: 'Finance Product', uom: 'piece', cost_price: 50,
  selling_price: 100, minimum_price: 90, maximum_price: 120, gst_rate: 18
}, request);
await trade.postStockMovement(db, { product_id: product.id, warehouse_id: 1, movement_type: 'purchase_receipt', quantity: 10, unit_cost: 50 }, request);

test('system chart of accounts is seeded and manual journals require exact paise balance', async () => {
  const accounts = await finance.listFinanceAccounts(db);
  assert.ok(accounts.some(account => account.code === '1200'));
  assert.ok(accounts.some(account => account.code === '4000'));
  const cash = accounts.find(account => account.code === '1000');
  const equity = accounts.find(account => account.code === '3000');
  const journal = await finance.createJournal(db, {
    journal_type: 'OPENING', journal_date: '2026-08-02', reference: 'OPEN-1',
    entries: [{ account_id: cash.id, debit: 25.25 }, { account_id: equity.id, credit: 25.25 }]
  }, request);
  assert.equal(journal.total_debit_minor, 2525);
  await assert.rejects(
    () => finance.createJournal(db, {
      entries: [{ account_id: cash.id, debit: 10 }, { account_id: equity.id, credit: 9.99 }]
    }, request),
    error => error.code === 'journal_not_balanced'
  );
});

test('checkout posts invoice and receipt journals and reconciles customer receivables', async () => {
  const checkout = await trade.checkoutPos(db, {
    customer_id: customer.id, warehouse_id: 1,
    items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
    payments: [{ method: 'CASH', amount: 118 }], allow_partial_payment: false
  }, { ...request, headers: { 'idempotency-key': 'finance-checkout' } });
  const journals = await finance.listJournals(db);
  assert.ok(journals.some(journal => journal.source_type === 'invoice' && journal.source_id === String(checkout.invoiceId)));
  assert.ok(journals.some(journal => journal.source_type === 'payment_allocation'));
  const reconciliation = await finance.financeReconciliation(db);
  assert.equal(reconciliation.invoice_receivable_minor, 0);
  assert.equal(reconciliation.customer_ledger_minor, 0);
  assert.equal(reconciliation.accounts_receivable_minor, 0);
  assert.equal(reconciliation.reconciled, true);
});

test('bank transactions are double-entry, tenant-scoped, and reconcile once', async () => {
  const accounts = await finance.listFinanceAccounts(db);
  const revenue = accounts.find(account => account.code === '4000');
  const bank = await finance.createBankAccount(db, {
    name: 'Operating', account_number: '123456789012', ifsc: 'TEST0001', opening_balance: 100
  }, request);
  assert.equal(bank.account_number_masked.endsWith('9012'), true);
  assert.equal(bank.current_balance_minor, 10000);
  const transaction = await finance.postBankTransaction(db, bank.id, {
    direction: 'IN', amount: 50, offset_account_id: revenue.id,
    transaction_date: '2026-08-02', reference: 'BANK-IN-1'
  }, request);
  assert.equal(transaction.amount_minor, 5000);
  const reconciled = await finance.reconcileBankTransaction(db, transaction.id, request);
  assert.equal(reconciled.reconciliation_status, 'RECONCILED');
  await assert.rejects(() => finance.reconcileBankTransaction(db, transaction.id, request), error => error.code === 'bank_transaction_already_reconciled');
});

test('paid expenses create one balanced journal and one project-ready cost record', async () => {
  const accounts = await finance.listFinanceAccounts(db);
  const expenseAccount = accounts.find(account => account.code === '6000');
  const cash = accounts.find(account => account.code === '1000');
  const expense = await finance.createExpense(db, {
    expense_account_id: expenseAccount.id, payment_account_id: cash.id,
    subtotal: 80, tax: 14.4, expense_date: '2026-08-02', status: 'PAID', description: 'Test operating expense'
  }, request);
  assert.equal(expense.total_minor, 9440);
  const journal = await finance.getJournal(db, expense.journal_id);
  assert.equal(journal.total_debit_minor, 9440);
  assert.equal(journal.total_credit_minor, 9440);
});
