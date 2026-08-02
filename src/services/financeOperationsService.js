import { httpError, parseJson, writeTenantAudit } from '../platform/phase5Http.js';
import { invalidateOrganizationCache, publishOrganizationEvent } from '../platform/phase5Runtime.js';
import { fromMinor, toMinor } from './moneyService.js';

const ACCOUNT_TYPES = new Set(['asset', 'liability', 'income', 'expense', 'equity']);

export async function listFinanceAccounts(db, query = {}) {
  const archived = query.archived === 'true' ? '' : 'WHERE a.is_archived = 0';
  const rows = await db.all(
    `SELECT a.*,
      COALESCE(SUM(je.debit_minor), 0) AS debit_minor,
      COALESCE(SUM(je.credit_minor), 0) AS credit_minor
      FROM accounts a LEFT JOIN journal_entries je ON je.account_id = a.id
      ${archived}
      GROUP BY a.id ORDER BY a.code`
  );
  return rows.map(accountView);
}

export async function createFinanceAccount(db, input, req) {
  const timestamp = now();
  const openingMinor = toMinor(input.opening_balance || 0, 'Opening balance');
  const inserted = await insertWithId(db,
    `INSERT INTO accounts
      (code, name, account_type, parent_id, opening_balance, opening_balance_minor,
       currency, is_archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [input.code.trim().toUpperCase(), input.name.trim(), input.account_type,
      input.parent_id || null, fromMinor(openingMinor), openingMinor,
      input.currency || 'INR', timestamp, timestamp]
  );
  const id = insertedId(inserted);
  const account = await db.one('SELECT * FROM accounts WHERE id = ?', [id]);
  await writeTenantAudit(db, req, { eventType: 'finance.account_created', entityType: 'account', entityId: id, after: account });
  await announce(req, 'finance.changed', { action: 'account_created', account_id: id });
  return accountView({ ...account, debit_minor: 0, credit_minor: 0 });
}

export async function listJournals(db, query = {}) {
  const where = [];
  const params = [];
  if (query.from) { where.push('journal_date >= ?'); params.push(query.from); }
  if (query.to) { where.push('journal_date <= ?'); params.push(query.to); }
  if (query.journal_type) { where.push('journal_type = ?'); params.push(String(query.journal_type).toUpperCase()); }
  return db.all(
    `SELECT * FROM journals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY journal_date DESC, id DESC LIMIT 500`, params
  ).then(rows => rows.map(journalView));
}

export async function getJournal(db, id) {
  const journal = await db.one('SELECT * FROM journals WHERE id = ?', [id]);
  if (!journal) throw httpError(404, 'journal_not_found', 'The journal was not found.');
  const entries = await db.all(
    `SELECT je.*, a.code AS account_code, a.name AS account_name, a.account_type
       FROM journal_entries je JOIN accounts a ON a.id = je.account_id
      WHERE je.journal_id = ? ORDER BY je.id`, [id]
  );
  return { ...journalView(journal), entries: entries.map(entryView) };
}

export async function createJournal(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const journalId = await db.transaction(tx => postJournalTx(tx, {
    journal_type: input.journal_type || 'GENERAL', journal_date: input.journal_date,
    reference: input.reference, description: input.description, entries: input.entries,
    idempotency_key: input.idempotency_key
  }, actorId));
  const journal = await getJournal(db, journalId);
  await writeTenantAudit(db, req, { eventType: 'finance.journal_posted', entityType: 'journal', entityId: journalId, after: journal });
  await announce(req, 'finance.changed', { action: 'journal_posted', journal_id: journalId });
  return journal;
}

export async function getAccountLedger(db, accountId, query = {}) {
  const account = await db.one('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) throw httpError(404, 'account_not_found', 'The account was not found.');
  const where = ['je.account_id = ?'];
  const params = [accountId];
  if (query.from) { where.push('j.journal_date >= ?'); params.push(query.from); }
  if (query.to) { where.push('j.journal_date <= ?'); params.push(query.to); }
  const entries = await db.all(
    `SELECT je.*, j.journal_no, j.journal_type, j.journal_date, j.reference,
            j.description AS journal_description, j.source_type, j.source_id
       FROM journal_entries je JOIN journals j ON j.id = je.journal_id
      WHERE ${where.join(' AND ')} ORDER BY j.journal_date, j.id, je.id`, params
  );
  let runningMinor = Number(account.opening_balance_minor || 0);
  const normalized = entries.map(row => {
    runningMinor += Number(row.debit_minor) - Number(row.credit_minor);
    return { ...entryView(row), running_balance_minor: runningMinor, running_balance: fromMinor(runningMinor) };
  });
  return {
    account: accountView({ ...account, debit_minor: 0, credit_minor: 0 }),
    opening_balance_minor: Number(account.opening_balance_minor || 0),
    closing_balance_minor: runningMinor,
    closing_balance: fromMinor(runningMinor), entries: normalized
  };
}

export async function createBankAccount(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const result = await db.transaction(async tx => {
    let accountId = input.account_id;
    const openingMinor = toMinor(input.opening_balance || 0, 'Opening balance');
    if (!accountId) {
      const accountInsert = await insertWithId(tx,
        `INSERT INTO accounts
          (code, name, account_type, opening_balance, opening_balance_minor, currency,
           is_archived, created_at, updated_at)
         VALUES (?, ?, 'asset', ?, ?, ?, 0, ?, ?)`,
        [input.code || `BANK-${Date.now().toString().slice(-6)}`, `${input.name} Bank`,
          fromMinor(openingMinor), openingMinor, input.currency || 'INR', now(), now()]
      );
      accountId = insertedId(accountInsert);
    }
    const account = await tx.one(`SELECT * FROM accounts WHERE id = ? AND account_type = 'asset' AND is_archived = 0`, [accountId]);
    if (!account) throw httpError(422, 'bank_ledger_account_invalid', 'An active asset account is required.');
    const inserted = await insertWithId(tx,
      `INSERT INTO bank_accounts
        (account_id, name, account_number_masked, ifsc, upi_id, opening_balance_minor,
         current_balance_minor, currency, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [accountId, input.name, maskAccountNumber(input.account_number), input.ifsc || null,
        input.upi_id || null, openingMinor, openingMinor, input.currency || 'INR', actorId, now(), now()]
    );
    return insertedId(inserted);
  });
  const bank = await db.one('SELECT * FROM bank_accounts WHERE id = ?', [result]);
  await writeTenantAudit(db, req, { eventType: 'finance.bank_created', entityType: 'bank_account', entityId: result, after: bank });
  await announce(req, 'finance.changed', { action: 'bank_created', bank_account_id: result });
  return bankView(bank);
}

export async function listBankAccounts(db) {
  const banks = await db.all(
    `SELECT b.*, a.code AS account_code, a.name AS ledger_name
       FROM bank_accounts b JOIN accounts a ON a.id = b.account_id ORDER BY b.name`
  );
  return banks.map(bankView);
}

export async function postBankTransaction(db, bankId, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const transactionId = await db.transaction(async tx => {
    const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const bank = await tx.one(`SELECT * FROM bank_accounts WHERE id = ?${lock}`, [bankId]);
    if (!bank || bank.status !== 'active') throw httpError(404, 'bank_account_not_found', 'The active bank account was not found.');
    if (Number(input.offset_account_id) === Number(bank.account_id)) throw httpError(422, 'bank_offset_account_invalid', 'Choose a different offset account.');
    const amountMinor = toMinor(input.amount, 'Bank transaction amount');
    if (amountMinor <= 0) throw httpError(422, 'positive_amount_required', 'A positive amount is required.');
    const direction = String(input.direction).toUpperCase();
    const entries = direction === 'IN'
      ? [{ account_id: bank.account_id, debit_minor: amountMinor }, { account_id: input.offset_account_id, credit_minor: amountMinor }]
      : [{ account_id: input.offset_account_id, debit_minor: amountMinor }, { account_id: bank.account_id, credit_minor: amountMinor }];
    const journalId = await postJournalTx(tx, {
      journal_type: 'BANK', journal_date: input.transaction_date,
      reference: input.reference, description: input.description || `Bank transaction: ${bank.name}`,
      source_type: 'bank_transaction', source_id: input.idempotency_key, entries
    }, actorId);
    const inserted = await insertWithId(tx,
      `INSERT INTO bank_transactions
        (bank_account_id, journal_id, direction, amount_minor, method, reference,
         description, transaction_date, reconciliation_status, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNRECONCILED', ?, ?)`,
      [bank.id, journalId, direction, amountMinor, input.method || 'BANK_TRANSFER',
        input.reference || null, input.description || null, input.transaction_date || today(), input.idempotency_key || null, now()]
    );
    const delta = direction === 'IN' ? amountMinor : -amountMinor;
    await tx.run('UPDATE bank_accounts SET current_balance_minor = current_balance_minor + ?, updated_at = ? WHERE id = ?', [delta, now(), bank.id]);
    return insertedId(inserted);
  });
  const transaction = await db.one('SELECT * FROM bank_transactions WHERE id = ?', [transactionId]);
  await writeTenantAudit(db, req, { eventType: 'finance.bank_transaction_posted', entityType: 'bank_transaction', entityId: transactionId, after: transaction });
  await announce(req, 'finance.changed', { action: 'bank_transaction_posted', transaction_id: transactionId });
  return bankTransactionView(transaction);
}

export async function reconcileBankTransaction(db, id, req) {
  const transaction = await db.one('SELECT * FROM bank_transactions WHERE id = ?', [id]);
  if (!transaction) throw httpError(404, 'bank_transaction_not_found', 'The bank transaction was not found.');
  if (transaction.reconciliation_status === 'RECONCILED') throw httpError(409, 'bank_transaction_already_reconciled', 'This transaction is already reconciled.');
  await db.run(`UPDATE bank_transactions SET reconciliation_status = 'RECONCILED', reconciled_at = ?, reconciled_by = ? WHERE id = ?`, [now(), req.user.id, id]);
  const after = await db.one('SELECT * FROM bank_transactions WHERE id = ?', [id]);
  await writeTenantAudit(db, req, { eventType: 'finance.bank_transaction_reconciled', entityType: 'bank_transaction', entityId: id, before: transaction, after });
  await announce(req, 'finance.changed', { action: 'bank_transaction_reconciled', transaction_id: Number(id) });
  return bankTransactionView(after);
}

export async function listExpenses(db, query = {}) {
  const where = [];
  const params = [];
  if (query.status) { where.push('e.status = ?'); params.push(String(query.status).toUpperCase()); }
  return db.all(
    `SELECT e.*, s.name AS supplier_name, a.name AS expense_account_name
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id
       JOIN accounts a ON a.id = e.expense_account_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.expense_date DESC, e.id DESC`, params
  ).then(rows => rows.map(expenseView));
}

export async function createExpense(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  const expenseId = await db.transaction(async tx => {
    const subtotalMinor = toMinor(input.subtotal, 'Expense subtotal');
    const taxMinor = toMinor(input.tax || 0, 'Expense tax');
    const totalMinor = subtotalMinor + taxMinor;
    if (totalMinor <= 0) throw httpError(422, 'positive_expense_required', 'Expense total must be positive.');
    const status = String(input.status || 'DRAFT').toUpperCase();
    let journalId = null;
    if (status !== 'DRAFT') {
      const creditAccountId = status === 'PAID' ? input.payment_account_id : await accountIdByCode(tx, '2000');
      if (!creditAccountId) throw httpError(422, 'expense_credit_account_required', 'A payment or payable account is required.');
      journalId = await postJournalTx(tx, {
        journal_type: 'EXPENSE', journal_date: input.expense_date,
        reference: input.reference, description: input.description || 'Business expense',
        source_type: 'expense', source_id: input.idempotency_key,
        entries: [{ account_id: input.expense_account_id, debit_minor: totalMinor }, { account_id: creditAccountId, credit_minor: totalMinor }]
      }, actorId);
    }
    const expenseNo = await nextFinanceNumber(tx, 'expense');
    const inserted = await insertWithId(tx,
      `INSERT INTO expenses
        (expense_no, supplier_id, expense_account_id, payment_account_id, subtotal_minor,
         tax_minor, total_minor, expense_date, description, reference, status,
         journal_id, project_id, idempotency_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [expenseNo, input.supplier_id || null, input.expense_account_id,
        input.payment_account_id || null, subtotalMinor, taxMinor, totalMinor,
        input.expense_date || today(), input.description || null, input.reference || null,
        status, journalId, input.project_id || null, input.idempotency_key || null,
        actorId, now(), now()]
    );
    const id = insertedId(inserted);
    if (input.project_id && status !== 'DRAFT') {
      await tx.run(
        `INSERT INTO project_entries
          (project_id, entry_type, source_type, source_id, amount_minor, occurred_at,
           description, created_by, created_at)
         VALUES (?, 'COST', 'expense', ?, ?, ?, ?, ?, ?)`,
        [input.project_id, String(id), totalMinor, input.expense_date || today(), input.description || expenseNo, actorId, now()]
      );
    }
    return id;
  });
  const expense = await db.one('SELECT * FROM expenses WHERE id = ?', [expenseId]);
  await writeTenantAudit(db, req, { eventType: 'finance.expense_created', entityType: 'expense', entityId: expenseId, after: expense });
  await announce(req, 'finance.changed', { action: 'expense_created', expense_id: expenseId });
  return expenseView(expense);
}

export async function financeSummary(db) {
  const accounts = await listFinanceAccounts(db);
  const total = type => accounts.filter(item => item.account_type === type).reduce((sum, item) => sum + Number(item.presentation_balance_minor), 0);
  const income = total('income');
  const expenses = total('expense');
  const bank = await db.one(`SELECT COALESCE(SUM(current_balance_minor), 0) AS amount FROM bank_accounts WHERE status = 'active'`);
  const outstanding = await db.one(`SELECT COALESCE(SUM(running_balance_minor), 0) AS amount FROM (SELECT customer_id, MAX(running_balance_minor) AS running_balance_minor FROM customer_ledger_entries GROUP BY customer_id) balances`);
  return {
    total_income_minor: income, total_expenses_minor: expenses,
    net_profit_minor: income - expenses, bank_balance_minor: Number(bank?.amount || 0),
    outstanding_receivable_minor: Math.max(Number(outstanding?.amount || 0), 0),
    total_income: fromMinor(income), total_expenses: fromMinor(expenses),
    net_profit: fromMinor(income - expenses), bank_balance: fromMinor(bank?.amount || 0),
    outstanding_receivable: fromMinor(Math.max(Number(outstanding?.amount || 0), 0))
  };
}

export async function financeReconciliation(db) {
  const [invoices, payments, refunds, adjustments, customerLedger, arLedger, bankState, bankPosted] = await Promise.all([
    db.one(`SELECT COALESCE(SUM(grand_total_minor), 0) AS amount FROM invoices WHERE invoice_status = 'ISSUED'`),
    db.one(`SELECT COALESCE(SUM(amount_minor), 0) AS amount FROM payment_allocations WHERE status = 'SUCCESS'`),
    db.one(`SELECT COALESCE(SUM(amount_minor), 0) AS amount FROM refunds WHERE status = 'SUCCESS'`),
    db.one(`SELECT
      COALESCE(SUM(CASE WHEN adjustment_type = 'CREDIT_NOTE' THEN grand_total_minor ELSE 0 END), 0) AS credits,
      COALESCE(SUM(CASE WHEN adjustment_type = 'DEBIT_NOTE' THEN grand_total_minor ELSE 0 END), 0) AS debits
      FROM fiscal_adjustments WHERE status = 'ISSUED' AND invoice_id IS NOT NULL`),
    db.one(`SELECT COALESCE(SUM(running_balance_minor), 0) AS amount FROM customer_ledger_entries cle
      WHERE cle.id IN (SELECT MAX(id) FROM customer_ledger_entries GROUP BY customer_id)`),
    db.one(`SELECT COALESCE(SUM(je.debit_minor - je.credit_minor), 0) AS amount
      FROM journal_entries je JOIN accounts a ON a.id = je.account_id WHERE a.code = '1200'`),
    db.one(`SELECT COALESCE(SUM(current_balance_minor), 0) AS amount FROM bank_accounts WHERE status = 'active'`),
    db.one(`SELECT
      COALESCE((SELECT SUM(opening_balance_minor) FROM bank_accounts WHERE status = 'active'), 0)
      + COALESCE((SELECT SUM(CASE WHEN direction = 'IN' THEN amount_minor ELSE -amount_minor END) FROM bank_transactions), 0) AS amount`)
  ]);
  const invoiceReceivable = Number(invoices?.amount || 0) - Number(adjustments?.credits || 0)
    + Number(adjustments?.debits || 0) - Number(payments?.amount || 0) + Number(refunds?.amount || 0);
  const customerLedgerMinor = Number(customerLedger?.amount || 0);
  const arLedgerMinor = Number(arLedger?.amount || 0);
  const bankExpectedMinor = Number(bankPosted?.amount || 0);
  const bankActualMinor = Number(bankState?.amount || 0);
  return {
    reconciled: invoiceReceivable === customerLedgerMinor
      && customerLedgerMinor === arLedgerMinor
      && bankActualMinor === bankExpectedMinor,
    invoice_receivable_minor: invoiceReceivable,
    customer_ledger_minor: customerLedgerMinor,
    accounts_receivable_minor: arLedgerMinor,
    receivable_variance_minor: invoiceReceivable - arLedgerMinor,
    bank_balance_minor: bankActualMinor,
    bank_transaction_net_minor: bankExpectedMinor,
    bank_variance_minor: bankActualMinor - bankExpectedMinor,
    invoice_receivable: fromMinor(invoiceReceivable),
    customer_ledger: fromMinor(customerLedgerMinor),
    accounts_receivable: fromMinor(arLedgerMinor),
    receivable_variance: fromMinor(invoiceReceivable - arLedgerMinor),
    bank_balance: fromMinor(bankActualMinor), bank_variance: fromMinor(bankActualMinor - bankExpectedMinor)
  };
}

export async function paymentTimeline(db, query = {}) {
  const invoiceFilter = query.invoice_id ? 'AND i.id = ?' : '';
  const params = query.invoice_id ? [query.invoice_id] : [];
  const rows = await db.all(
    `SELECT * FROM (
      SELECT i.issued_at AS occurred_at, 'INVOICE_ISSUED' AS event_type, i.id AS invoice_id,
             i.invoice_number AS reference, i.grand_total_minor AS amount_minor, i.payment_status AS status
        FROM invoices i WHERE 1 = 1 ${invoiceFilter}
      UNION ALL
      SELECT pa.created_at, 'PAYMENT_ALLOCATION', pa.invoice_id, p.payment_number,
             pa.amount_minor, pa.status
        FROM payment_allocations pa LEFT JOIN payments p ON p.id = pa.payment_id
       WHERE 1 = 1 ${query.invoice_id ? 'AND pa.invoice_id = ?' : ''}
      UNION ALL
      SELECT r.created_at, 'REFUND', r.invoice_id, r.refund_number, r.amount_minor, r.status
        FROM refunds r WHERE 1 = 1 ${query.invoice_id ? 'AND r.invoice_id = ?' : ''}
      UNION ALL
      SELECT pl.created_at, 'PAYMENT_LINK', pl.invoice_id, CAST(pl.id AS TEXT), pl.amount_minor, pl.status
        FROM payment_links pl WHERE 1 = 1 ${query.invoice_id ? 'AND pl.invoice_id = ?' : ''}
    ) timeline ORDER BY occurred_at DESC LIMIT 1000`,
    query.invoice_id ? [...params, ...params, ...params, ...params] : []
  );
  return rows.map(row => ({ ...row, amount: fromMinor(row.amount_minor || 0) }));
}

export async function postInvoiceAccountingTx(tx, { invoiceId, invoiceNumber, customerId, taxableMinor, taxMinor, grandTotalMinor, issuedAt }, actorId) {
  if (grandTotalMinor <= 0) return null;
  return postJournalTx(tx, {
    journal_type: 'INVOICE', journal_date: String(issuedAt || today()).slice(0, 10),
    reference: invoiceNumber, description: `Invoice ${invoiceNumber} issued.`,
    source_type: 'invoice', source_id: String(invoiceId),
    entries: [
      { account_id: await accountIdByCode(tx, '1200'), debit_minor: grandTotalMinor, party_type: 'customer', party_id: customerId },
      { account_id: await accountIdByCode(tx, '4000'), credit_minor: taxableMinor },
      ...(taxMinor > 0 ? [{ account_id: await accountIdByCode(tx, '2100'), credit_minor: taxMinor }] : [])
    ]
  }, actorId);
}

export async function postPaymentAccountingTx(tx, allocation, actorId) {
  if (allocation.status !== 'SUCCESS') return null;
  const cashCode = allocation.method === 'CASH' ? '1000' : '1100';
  return postJournalTx(tx, {
    journal_type: 'RECEIPT', journal_date: today(), reference: allocation.payment_number,
    description: `${allocation.method} received.`, source_type: 'payment_allocation', source_id: String(allocation.id),
    entries: [
      { account_id: await accountIdByCode(tx, cashCode), debit_minor: allocation.amount_minor },
      { account_id: await accountIdByCode(tx, '1200'), credit_minor: allocation.amount_minor }
    ]
  }, actorId);
}

export async function postRefundAccountingTx(tx, refund, allocation, actorId) {
  const cashCode = allocation.method === 'CASH' ? '1000' : '1100';
  return postJournalTx(tx, {
    journal_type: 'REFUND', journal_date: today(), reference: refund.refund_number,
    description: `Refund against invoice ${allocation.invoice_number || allocation.invoice_id}.`,
    source_type: 'refund', source_id: String(refund.refund_id),
    entries: [
      { account_id: await accountIdByCode(tx, '1200'), debit_minor: refund.amount_minor },
      { account_id: await accountIdByCode(tx, cashCode), credit_minor: refund.amount_minor }
    ]
  }, actorId);
}

export async function postFiscalAdjustmentAccountingTx(tx, adjustment, actorId) {
  const isCredit = adjustment.adjustment_type === 'CREDIT_NOTE';
  const entries = isCredit
    ? [
      { account_id: await accountIdByCode(tx, '4000'), debit_minor: Number(adjustment.subtotal_minor) },
      ...(Number(adjustment.tax_total_minor) > 0 ? [{ account_id: await accountIdByCode(tx, '2100'), debit_minor: Number(adjustment.tax_total_minor) }] : []),
      { account_id: await accountIdByCode(tx, '1200'), credit_minor: Number(adjustment.grand_total_minor), party_type: 'customer', party_id: adjustment.party_id }
    ]
    : [
      { account_id: await accountIdByCode(tx, '2000'), debit_minor: Number(adjustment.grand_total_minor), party_type: 'supplier', party_id: adjustment.party_id },
      { account_id: await accountIdByCode(tx, '5000'), credit_minor: Number(adjustment.grand_total_minor) }
    ];
  return postJournalTx(tx, {
    journal_type: adjustment.adjustment_type, journal_date: today(),
    reference: adjustment.adjustment_number, description: adjustment.reason,
    source_type: 'fiscal_adjustment', source_id: String(adjustment.id), entries
  }, actorId);
}

export async function postJournalTx(tx, input, actorId) {
  const entries = normalizeJournalEntries(input.entries);
  const totalDebit = entries.reduce((sum, entry) => sum + entry.debit_minor, 0);
  const totalCredit = entries.reduce((sum, entry) => sum + entry.credit_minor, 0);
  if (totalDebit <= 0 || totalDebit !== totalCredit) throw httpError(422, 'journal_not_balanced', 'Journal debits and credits must balance exactly.');
  const ids = [...new Set(entries.map(entry => Number(entry.account_id)))];
  const accounts = await tx.all(`SELECT id FROM accounts WHERE is_archived = 0 AND id IN (${ids.map(() => '?').join(',')})`, ids);
  if (accounts.length !== ids.length) throw httpError(422, 'journal_account_invalid', 'One or more journal accounts are invalid or archived.');
  if (input.source_type && input.source_id) {
    const existing = await tx.one(
      'SELECT id FROM journals WHERE source_type = ? AND source_id = ? AND journal_type = ?',
      [input.source_type, String(input.source_id), String(input.journal_type || 'GENERAL').toUpperCase()]
    );
    if (existing) return existing.id;
  }
  const journalNo = await nextFinanceNumber(tx, 'journal');
  const timestamp = now();
  const inserted = await insertWithId(tx,
    `INSERT INTO journals
      (journal_no, journal_type, journal_date, reference, description, source_type,
       source_id, status, total_debit_minor, total_credit_minor, idempotency_key,
       created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?)`,
    [journalNo, String(input.journal_type || 'GENERAL').toUpperCase(), input.journal_date || today(),
      input.reference || null, input.description || null, input.source_type || null,
      input.source_id == null ? null : String(input.source_id), totalDebit, totalCredit,
      input.idempotency_key || null, actorId, timestamp]
  );
  const journalId = insertedId(inserted);
  for (const entry of entries) {
    await tx.run(
      `INSERT INTO journal_entries
        (journal_id, account_id, debit_minor, credit_minor, party_type, party_id,
         project_id, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [journalId, entry.account_id, entry.debit_minor, entry.credit_minor,
        entry.party_type || null, entry.party_id || null, entry.project_id || null,
        entry.description || null, timestamp]
    );
  }
  return journalId;
}

function normalizeJournalEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 2) throw httpError(422, 'journal_lines_required', 'A journal requires at least two entries.');
  return entries.map(entry => {
    const debitMinor = entry.debit_minor != null ? Number(entry.debit_minor) : toMinor(entry.debit || 0, 'Journal debit');
    const creditMinor = entry.credit_minor != null ? Number(entry.credit_minor) : toMinor(entry.credit || 0, 'Journal credit');
    if (!Number(entry.account_id) || debitMinor < 0 || creditMinor < 0 || (debitMinor > 0) === (creditMinor > 0)) {
      throw httpError(422, 'journal_line_invalid', 'Each journal line requires one positive debit or credit.');
    }
    return { ...entry, account_id: Number(entry.account_id), debit_minor: debitMinor, credit_minor: creditMinor };
  });
}

async function accountIdByCode(tx, code) {
  const account = await tx.one('SELECT id FROM accounts WHERE code = ? AND is_archived = 0', [code]);
  if (!account) throw httpError(409, 'system_account_missing', `Required system account ${code} is missing.`);
  return account.id;
}

async function nextFinanceNumber(tx, key) {
  const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
  let sequence = await tx.one(`SELECT * FROM number_sequences WHERE sequence_key = ?${lock}`, [key]);
  if (!sequence) {
    const prefix = key === 'expense' ? 'EXP' : key === 'project' ? 'PRJ' : 'JV';
    await tx.run('INSERT INTO number_sequences (sequence_key, prefix, next_value, padding, updated_at) VALUES (?, ?, 2, 6, ?)', [key, prefix, now()]);
    sequence = { prefix, next_value: 1, padding: 6 };
  } else {
    await tx.run('UPDATE number_sequences SET next_value = next_value + 1, updated_at = ? WHERE sequence_key = ?', [now(), key]);
  }
  return `${sequence.prefix}-${String(sequence.next_value).padStart(Number(sequence.padding), '0')}`;
}

function accountView(row) {
  const debit = Number(row.debit_minor || 0);
  const credit = Number(row.credit_minor || 0);
  const opening = Number(row.opening_balance_minor || 0);
  const signed = opening + debit - credit;
  const presentation = ['liability', 'income', 'equity'].includes(row.account_type) ? -signed : signed;
  return { ...row, balance_minor: signed, balance: fromMinor(signed), presentation_balance_minor: presentation, presentation_balance: fromMinor(presentation) };
}
function journalView(row) { return { ...row, total_debit: fromMinor(row.total_debit_minor), total_credit: fromMinor(row.total_credit_minor) }; }
function entryView(row) { return { ...row, debit: fromMinor(row.debit_minor), credit: fromMinor(row.credit_minor) }; }
function bankView(row) { return { ...row, opening_balance: fromMinor(row.opening_balance_minor), current_balance: fromMinor(row.current_balance_minor) }; }
function bankTransactionView(row) { return { ...row, amount: fromMinor(row.amount_minor) }; }
function expenseView(row) { return { ...row, subtotal: fromMinor(row.subtotal_minor), tax: fromMinor(row.tax_minor), total: fromMinor(row.total_minor) }; }
function maskAccountNumber(value) { const text = String(value || '').replace(/\s/g, ''); return text.length <= 4 ? text : `${'*'.repeat(Math.min(text.length - 4, 8))}${text.slice(-4)}`; }
function insertedId(result) { return result.id || result.rows?.[0]?.id; }
function insertWithId(tx, sql, params) { return tx.run(`${sql}${tx.dialect === 'postgres' ? ' RETURNING id' : ''}`, params); }
function now() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }
async function announce(req, event, payload) {
  await invalidateOrganizationCache(req.user.organization_id);
  await publishOrganizationEvent(req.user.organization_id, event, payload);
}

export function validateAccountType(value) {
  if (!ACCOUNT_TYPES.has(value)) throw httpError(422, 'account_type_invalid', 'Account type must be asset, liability, income, expense, or equity.');
  return value;
}
