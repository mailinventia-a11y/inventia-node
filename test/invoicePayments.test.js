import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inventia-invoice-payments-test-'));
process.env.NODE_ENV = 'test';
process.env.PHASE5_DATA_DIR = path.join(testRoot, 'control');
process.env.DEFAULT_TENANT_DATABASE_URL = `sqlite:${path.join(testRoot, 'tenant.db')}`;
process.env.JWT_SECRET = 'invoice-payment-test-jwt-secret';
process.env.TENANT_MASTER_KEY = 'invoice-payment-test-master-key';
process.env.INVOICE_STORAGE_DIR = path.join(testRoot, 'uploads');
delete process.env.CONTROL_DATABASE_URL;
delete process.env.TENANT_DATABASE_ADMIN_URL;
delete process.env.REDIS_URL;

const databaseModule = await import('../src/platform/phase5Database.js');
const authModule = await import('../src/platform/phase5Auth.js');
const trade = await import('../src/services/enterpriseTradeService.js');
const invoicePayments = await import('../src/services/invoicePaymentService.js');
const { executeIdempotent } = await import('../src/platform/phase5Http.js');
const razorpay = await import('../src/services/razorpayService.js');

const { defaultTenant: db } = await databaseModule.initializePhase5Platform({
  hashPassword: authModule.hashPlatformPassword
});
const session = await authModule.loginPlatform({ username: 'admin', password: 'admin123' });
const request = {
  requestId: 'invoice-payment-test',
  user: {
    id: session.user.id,
    tenant_user_id: session.user.id,
    role: session.user.role,
    permissions: ['*'],
    organization_id: session.organization.id
  },
  headers: { 'idempotency-key': 'invoice-payment-test-1' },
  ip: '127.0.0.1',
  tenantDb: db,
  invoicePdfGenerator: async () => {
    throw new Error('Simulated Puppeteer outage');
  }
};

await db.run(
  `INSERT INTO warehouses (name, code, type, created_at) VALUES ('Invoice Main', 'INV-MAIN', 'warehouse', ?)`,
  [new Date().toISOString()]
);
await db.run(
  `INSERT INTO organization_settings (setting_key, setting_value, updated_at)
   VALUES ('state_code', ?, ?), ('company_state', ?, ?), ('company_gstin', ?, ?)`,
  [
    JSON.stringify('29'), new Date().toISOString(),
    JSON.stringify('Karnataka'), new Date().toISOString(),
    JSON.stringify('29ABCDE1234F1Z5'), new Date().toISOString()
  ]
);
const customer = await trade.createParty(db, 'customer', {
  name: 'GST Customer',
  phone: '9000000000',
  address: 'Bengaluru',
  gstin: '29AAAAA0000A1Z5',
  credit_limit: 10000
}, request);
const product = await trade.createProduct(db, {
  sku: 'GST-TEST-001',
  name: 'GST Test Product',
  uom: 'piece',
  cost_price: 60,
  selling_price: 100,
  minimum_price: 90,
  maximum_price: 120,
  hsn_code: '9403',
  gst_rate: 18,
  valuation_method: 'weighted_average'
}, request);
await trade.postStockMovement(db, {
  product_id: product.id,
  warehouse_id: 1,
  movement_type: 'purchase_receipt',
  quantity: 50,
  unit_cost: 60
}, request);

function checkoutRequest(key) {
  return { ...request, headers: { 'idempotency-key': key } };
}

test('GST invoice and unified payments remain atomic while PDF generation is retryable', async t => {
  let paidInvoice;
  await t.test('paid cash checkout uses paise-safe GST and keeps the sale after PDF failure', async () => {
    paidInvoice = await trade.checkoutPos(db, {
      customer_id: customer.id,
      warehouse_id: 1,
      items: [{ product_id: product.id, quantity: 3, unit_price: 100 }],
      discount: 10.01,
      payments: [{ method: 'CASH', amount: 342.19 }],
      allow_partial_payment: false,
      invoice_details: {
        customer_state: 'Karnataka',
        customer_state_code: '29',
        customer_gstin: '29AAAAA0000A1Z5'
      }
    }, checkoutRequest('cash-checkout'));

    assert.equal(paidInvoice.success, true);
    assert.match(paidInvoice.invoiceNumber, /^INV-\d{4}-\d{6}$/);
    assert.equal(paidInvoice.paymentStatus, 'PAID');
    assert.equal(paidInvoice.paymentSummary.outstanding_minor, 0);
    assert.equal(paidInvoice.pdf.status, 'FAILED');
    assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM sales')).count), 1);
    assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM invoices')).count), 1);
    assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM document_generation_jobs')).count), 1);

    const invoice = await invoicePayments.getInvoice(db, paidInvoice.invoiceId);
    assert.equal(Number(invoice.taxable_total_minor), 28999);
    assert.equal(Number(invoice.cgst_total_minor), 2610);
    assert.equal(Number(invoice.sgst_total_minor), 2610);
    assert.equal(Number(invoice.igst_total_minor), 0);
    assert.equal(Number(invoice.grand_total_minor), 34219);
    assert.equal(invoice.items[0].hsn_sac, '9403');
  });

  await t.test('PDF retry creates a version without duplicating commercial records', async () => {
    const before = {
      sales: Number((await db.one('SELECT COUNT(*) AS count FROM sales')).count),
      invoices: Number((await db.one('SELECT COUNT(*) AS count FROM invoices')).count),
      allocations: Number((await db.one('SELECT COUNT(*) AS count FROM payment_allocations')).count),
      stock: Number((await db.one('SELECT COUNT(*) AS count FROM stock_movements')).count)
    };
    const result = await invoicePayments.retryInvoicePdf(
      db,
      request.user.organization_id,
      paidInvoice.invoiceId,
      checkoutRequest('pdf-retry'),
      { generateBuffer: async () => Buffer.from('%PDF-1.7\n% Inventia test PDF\n%%EOF') }
    );
    assert.equal(result.pdf.status, 'READY');
    assert.equal(result.pdf.version, 1);
    assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM invoice_pdf_versions')).count), 1);
    assert.deepEqual({
      sales: Number((await db.one('SELECT COUNT(*) AS count FROM sales')).count),
      invoices: Number((await db.one('SELECT COUNT(*) AS count FROM invoices')).count),
      allocations: Number((await db.one('SELECT COUNT(*) AS count FROM payment_allocations')).count),
      stock: Number((await db.one('SELECT COUNT(*) AS count FROM stock_movements')).count)
    }, before);
  });

  await t.test('split partial payment settles later and keeps the customer ledger consistent', async () => {
    const partial = await trade.checkoutPos(db, {
      customer_id: customer.id,
      warehouse_id: 1,
      items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      payments: [
        { method: 'CASH', amount: 30 },
        { method: 'UPI', amount: 20, reference: 'UPI-SPLIT-001' }
      ],
      allow_partial_payment: true,
      due_date: '2026-08-30',
      invoice_details: { customer_state_code: '29' }
    }, checkoutRequest('partial-split'));
    assert.equal(partial.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(partial.paymentSummary.outstanding, 68);

    const settled = await invoicePayments.collectInvoicePayment(db, partial.invoiceId, {
      payments: [{ method: 'CASH', amount: 68 }],
      allow_partial_payment: false
    }, checkoutRequest('partial-settlement'));
    assert.equal(settled.payment_summary.status, 'PAID');
    const ledger = await db.one(
      `SELECT running_balance_minor FROM customer_ledger_entries
        WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
      [customer.id]
    );
    assert.equal(Number(ledger.running_balance_minor), 0);
    assert.equal(Number((await db.one('SELECT balance FROM customers WHERE id = ?', [customer.id])).balance), 0);
  });

  await t.test('pending cheque requires authorized confirmation', async () => {
    const cheque = await trade.checkoutPos(db, {
      customer_id: customer.id,
      warehouse_id: 1,
      items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      payments: [{ method: 'CHEQUE', amount: 118, reference: 'CHQ-1001' }],
      allow_partial_payment: true,
      due_date: '2026-08-30',
      invoice_details: { customer_state_code: '29' }
    }, checkoutRequest('cheque-checkout'));
    assert.equal(cheque.paymentStatus, 'UNPAID');
    const confirmed = await invoicePayments.confirmPaymentAllocation(
      db,
      cheque.allocations[0].id,
      checkoutRequest('cheque-confirm')
    );
    assert.equal(confirmed.payment_summary.status, 'PAID');
  });

  await t.test('refunds are bounded by the successful allocation and update payment state', async () => {
    const result = await invoicePayments.refundPaymentAllocation(
      db,
      paidInvoice.allocations[0].id,
      { amount: 10.01, reason: 'Returned item' },
      checkoutRequest('cash-refund')
    );
    assert.equal(result.amount_minor, 1001);
    assert.equal(result.payment_summary.status, 'PARTIALLY_REFUNDED');
    await assert.rejects(
      () => invoicePayments.refundPaymentAllocation(
        db,
        paidInvoice.allocations[0].id,
        { amount: 400, reason: 'Invalid excess' },
        checkoutRequest('cash-refund-excess')
      ),
      error => error.code === 'refund_exceeds_allocation'
    );
  });

  await t.test('Razorpay refunds link provider attempts to canonical allocations and ledgers', async () => {
    const credentials = {
      key_id: 'rzp_test_invoice',
      key_secret: 'invoice-payment-secret',
      webhook_secret: 'invoice-webhook-secret'
    };
    await db.run(
      `INSERT INTO integration_credentials (provider, encrypted_config, status, updated_by, updated_at)
       VALUES ('razorpay', ?, 'active', ?, ?)`,
      [databaseModule.encryptIntegrationConfig(credentials), request.user.id, new Date().toISOString()]
    );
    await db.run(
      `UPDATE payment_allocations
          SET method = 'RAZORPAY', provider = 'razorpay',
              provider_transaction_id = 'pay_invoice_linked'
        WHERE id = ?`,
      [paidInvoice.allocations[0].id]
    );
    await db.run(
      `INSERT INTO payment_gateway_transactions
        (provider, provider_order_id, provider_payment_id, direction, amount, currency,
         status, trade_document_id, customer_id, idempotency_key, raw_response, created_at, updated_at)
       VALUES ('razorpay', 'order_invoice_linked', 'pay_invoice_linked', 'payment', 342.19,
               'INR', 'captured', ?, ?, 'linked-gateway-payment', '{}', ?, ?)`,
      [
        paidInvoice.tradeDocumentId, customer.id,
        new Date().toISOString(), new Date().toISOString()
      ]
    );
    await db.run(
      `INSERT INTO payment_attempts
        (allocation_id, invoice_id, provider, provider_order_id, provider_payment_id,
         amount_minor, currency, status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'razorpay', 'order_invoice_linked', 'pay_invoice_linked',
               34219, 'INR', 'CAPTURED', 'linked-payment-attempt', ?, ?)`,
      [
        paidInvoice.allocations[0].id, paidInvoice.invoiceId,
        new Date().toISOString(), new Date().toISOString()
      ]
    );
    const mockSdkFactory = () => ({
      payments: {
        refund: async (_paymentId, input) => ({
          id: 'rfnd_invoice_linked',
          payment_id: 'pay_invoice_linked',
          amount: input.amount,
          currency: 'INR',
          status: 'processed'
        })
      }
    });
    const result = await razorpay.refundRazorpayPayment(
      db,
      { payment_id: 'pay_invoice_linked', amount: 5, reason: 'Gateway refund test' },
      checkoutRequest('razorpay-linked-refund'),
      mockSdkFactory
    );
    assert.equal(result.refund.id, 'rfnd_invoice_linked');
    const canonicalRefund = await db.one(
      `SELECT * FROM refunds WHERE provider_refund_id = 'rfnd_invoice_linked'`
    );
    assert.equal(Number(canonicalRefund.amount_minor), 500);
    const refundAttempt = await db.one(
      `SELECT * FROM payment_attempts WHERE provider_refund_id = 'rfnd_invoice_linked'`
    );
    assert.equal(refundAttempt.status, 'REFUNDED');
  });

  await t.test('interstate supply uses IGST and reference/disabled policies are server-enforced', async () => {
    const interstate = await trade.checkoutPos(db, {
      customer_id: customer.id,
      warehouse_id: 1,
      items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      payments: [{ method: 'CASH', amount: 118 }],
      invoice_details: { customer_state: 'Maharashtra', customer_state_code: '27' }
    }, checkoutRequest('interstate-checkout'));
    const detail = await invoicePayments.getInvoice(db, interstate.invoiceId);
    assert.equal(Number(detail.cgst_total_minor), 0);
    assert.equal(Number(detail.sgst_total_minor), 0);
    assert.equal(Number(detail.igst_total_minor), 1800);

    const salesBefore = Number((await db.one('SELECT COUNT(*) AS count FROM sales')).count);
    await assert.rejects(
      () => trade.checkoutPos(db, {
        customer_id: customer.id,
        warehouse_id: 1,
        items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
        payments: [{ method: 'UPI', amount: 118 }],
        invoice_details: { customer_state_code: '29' }
      }, checkoutRequest('missing-upi-ref')),
      error => error.code === 'payment_reference_required'
    );
    assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM sales')).count), salesBefore);

    await db.run(`UPDATE payment_method_settings SET enabled = 0 WHERE method = 'OTHER'`);
    await assert.rejects(
      () => trade.checkoutPos(db, {
        customer_id: customer.id,
        warehouse_id: 1,
        items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
        payments: [{ method: 'OTHER', amount: 118, reference: 'OTHER-1' }],
        allow_partial_payment: true,
        due_date: '2026-08-30',
        invoice_details: { customer_state_code: '29' }
      }, checkoutRequest('disabled-other')),
      error => error.code === 'payment_method_disabled'
    );
    assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM sales')).count), salesBefore);
  });

  await t.test('concurrent checkouts allocate different yearly invoice numbers', async () => {
    const payload = {
      customer_id: customer.id,
      warehouse_id: 1,
      items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      payments: [{ method: 'CASH', amount: 118 }],
      invoice_details: { customer_state_code: '29' }
    };
    const [left, right] = await Promise.all([
      trade.checkoutPos(db, payload, checkoutRequest('concurrent-left')),
      trade.checkoutPos(db, payload, checkoutRequest('concurrent-right'))
    ]);
    assert.notEqual(left.invoiceNumber, right.invoiceNumber);
  });

  await t.test('duplicate checkout submission replays without duplicating sale or stock', async () => {
    const body = {
      customer_id: customer.id,
      warehouse_id: 1,
      items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
      payments: [{ method: 'CASH', amount: 118 }],
      invoice_details: { customer_state_code: '29' }
    };
    const idempotentRequest = {
      ...checkoutRequest('duplicate-checkout'),
      method: 'POST',
      path: '/pos/checkout',
      originalUrl: '/api/v1/pos/checkout',
      body
    };
    const salesBefore = Number((await db.one('SELECT COUNT(*) AS count FROM sales')).count);
    const first = await executeIdempotent(idempotentRequest, async () => ({
      status: 201,
      body: await trade.checkoutPos(db, body, idempotentRequest)
    }));
    const second = await executeIdempotent(idempotentRequest, async () => {
      throw new Error('Replay should not execute checkout again.');
    });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.body.invoiceId, first.body.invoiceId);
    assert.equal(Number((await db.one('SELECT COUNT(*) AS count FROM sales')).count), salesBefore + 1);
  });

  await t.test('invoice records cannot be resolved through another tenant database', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000077';
    const control = databaseModule.getControlDatabase();
    const timestamp = new Date().toISOString();
    await control.run(
      `INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
       VALUES (?, 'invoice-isolation', 'Invoice Isolation', 'active', ?, ?)`,
      [organizationId, timestamp, timestamp]
    );
    const isolated = await databaseModule.provisionOrganizationDatabase({
      organizationId,
      slug: 'invoice-isolation'
    });
    await assert.rejects(
      () => invoicePayments.getInvoice(isolated, paidInvoice.invoiceId),
      error => error.code === 'invoice_not_found'
    );
  });

  await t.test('phase5-invoice-payments-002 backfills a legacy sale without changing stock', async () => {
    const stockBefore = Number((await db.one(
      'SELECT quantity FROM warehouse_stock WHERE warehouse_id = 1 AND product_id = ?',
      [product.id]
    )).quantity);
    const timestamp = new Date().toISOString();
    const saleInsert = await db.run(
      `INSERT INTO sales
        (invoice_no, customer_id, warehouse_id, user_id, subtotal, discount,
         tax_amount, total, payment_method, payment_status, sale_date)
       VALUES ('INV-LEGACY-TEST', ?, 1, ?, 100, 0, 18, 118, 'cash', 'completed', ?)`,
      [customer.id, request.user.id, timestamp]
    );
    await db.run(
      `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price)
       VALUES (?, ?, 1, 100, 118)`,
      [saleInsert.id, product.id]
    );
    await db.run(`DELETE FROM migration_versions WHERE version = 'phase5-invoice-payments-002'`);
    await databaseModule.migrateTenantDatabase(db);
    const imported = await db.one(`SELECT * FROM invoices WHERE sale_id = ?`, [saleInsert.id]);
    assert.equal(imported.invoice_number, 'INV-LEGACY-TEST');
    assert.equal(imported.payment_status, 'PAID');
    assert.equal(Number((await db.one(
      'SELECT quantity FROM warehouse_stock WHERE warehouse_id = 1 AND product_id = ?',
      [product.id]
    )).quantity), stockBefore);
  });
});
