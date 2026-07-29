import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';

const router = express.Router();
const financeUser = checkRole(['admin', 'manager']);
const financeViewer = checkRole(['admin', 'manager', 'cashier']);
const accountTypes = ['asset', 'liability', 'income', 'expense', 'equity'];

router.get('/accounts', financeViewer, async (req, res) => {
  const { data, error } = await supabase.from('accounts').select('*').order('code');
  if (error) return res.status(500).json({ error: error.message });
  const includeArchived = req.query.archived === 'true';
  res.json(data.filter(account => includeArchived || !account.is_archived));
});

router.post('/accounts', financeUser, async (req, res) => {
  const { code, name, account_type, parent_id = null, opening_balance = 0 } = req.body;
  if (!code?.trim() || !name?.trim() || !accountTypes.includes(account_type)) {
    return res.status(400).json({ error: 'Code, name, and a valid account type are required.' });
  }
  const { data, error } = await supabase.from('accounts').insert([{
    code: code.trim(), name: name.trim(), account_type, parent_id,
    opening_balance: Number(opening_balance) || 0, is_archived: 0
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data[0]);
});

router.put('/accounts/:id', financeUser, async (req, res) => {
  const allowed = pick(req.body, ['code', 'name', 'account_type', 'parent_id', 'opening_balance']);
  if (allowed.account_type && !accountTypes.includes(allowed.account_type)) {
    return res.status(400).json({ error: 'Invalid account type.' });
  }
  const { data, error } = await supabase.from('accounts').update(allowed).eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  if (!data[0]) return res.status(404).json({ error: 'Account not found.' });
  res.json(data[0]);
});

router.put('/accounts/:id/archive', financeUser, async (req, res) => {
  const { data, error } = await supabase.from('accounts').update({
    is_archived: req.body.archived === false ? 0 : 1
  }).eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

router.post('/accounts/:id/merge', financeUser, async (req, res) => {
  const sourceId = Number(req.params.id);
  const targetId = Number(req.body.target_account_id);
  if (!targetId || targetId === sourceId) return res.status(400).json({ error: 'Choose a different target account.' });
  const { data: target } = await supabase.from('accounts').select('*').eq('id', targetId).single();
  if (!target) return res.status(404).json({ error: 'Target account not found.' });
  await supabase.from('journal_entries').update({ account_id: targetId }).eq('account_id', sourceId);
  await supabase.from('accounts').update({ is_archived: 1, merged_into_id: targetId }).eq('id', sourceId);
  await emitEvent('finance.account_merged', 'account', sourceId, req.user.id, { target_account_id: targetId });
  res.json({ success: true, source_account_id: sourceId, target_account_id: targetId });
});

router.get('/journals', financeViewer, async (req, res) => {
  const { data, error } = await supabase.from('journals').select('*').order('journal_date', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(filterByDate(data, req.query.from, req.query.to, 'journal_date'));
});

router.post('/journals', financeUser, async (req, res) => {
  try {
    const journal = await createJournal({
      journalType: req.body.journal_type || 'general',
      date: req.body.journal_date,
      reference: req.body.reference,
      description: req.body.description,
      entries: req.body.entries,
      userId: req.user.id
    });
    res.status(201).json(journal);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/ledger/:accountId', financeViewer, async (req, res) => {
  const accountId = Number(req.params.accountId);
  const { data: account } = await supabase.from('accounts').select('*').eq('id', accountId).single();
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const { data: entries, error } = await supabase.from('journal_entries').select('*').eq('account_id', accountId);
  if (error) return res.status(500).json({ error: error.message });
  const { data: journals } = await supabase.from('journals').select('*');
  const journalMap = new Map((journals || []).map(journal => [journal.id, journal]));
  let runningBalance = Number(account.opening_balance || 0);
  const ledger = entries.map(entry => ({ ...entry, journal: journalMap.get(entry.journal_id) }))
    .filter(entry => entry.journal)
    .sort((a, b) => new Date(a.journal.journal_date) - new Date(b.journal.journal_date))
    .map(entry => {
      runningBalance += Number(entry.debit || 0) - Number(entry.credit || 0);
      return { ...entry, running_balance: round(runningBalance) };
    });
  res.json({ account, opening_balance: Number(account.opening_balance || 0), closing_balance: round(runningBalance), entries: ledger });
});

router.get('/banks', financeViewer, async (_req, res) => {
  const { data, error } = await supabase.from('banks').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/banks', financeUser, async (req, res) => {
  const { name, account_number, ifsc, upi_id, opening_balance = 0 } = req.body;
  if (!name?.trim() || !account_number?.trim()) return res.status(400).json({ error: 'Bank name and account number are required.' });
  let accountId = req.body.account_id;
  if (!accountId) {
    const { data: accounts, error: accountError } = await supabase.from('accounts').insert([{
      code: `BANK-${Date.now().toString().slice(-6)}`, name: `${name.trim()} Bank`,
      account_type: 'asset', opening_balance: Number(opening_balance) || 0, is_archived: 0
    }]).select();
    if (accountError) return res.status(400).json({ error: accountError.message });
    accountId = accounts[0].id;
  }
  const { data, error } = await supabase.from('banks').insert([{
    name: name.trim(), account_number: account_number.trim(), ifsc, upi_id,
    account_id: accountId, current_balance: Number(opening_balance) || 0, status: 'active'
  }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data[0]);
});

router.post('/banks/:id/transactions', financeUser, async (req, res) => {
  const { data: bank } = await supabase.from('banks').select('*').eq('id', req.params.id).single();
  if (!bank) return res.status(404).json({ error: 'Bank account not found.' });
  const amount = positiveAmount(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'A positive amount is required.' });
  const direction = req.body.direction === 'out' ? 'out' : 'in';
  const offset = Number(req.body.offset_account_id);
  if (!offset) return res.status(400).json({ error: 'offset_account_id is required for double-entry posting.' });
  try {
    const journal = await createJournal({
      journalType: 'bank', date: req.body.transaction_date, reference: req.body.reference,
      description: req.body.description || `Bank transaction: ${bank.name}`, userId: req.user.id,
      entries: direction === 'in'
        ? [{ account_id: bank.account_id, debit: amount }, { account_id: offset, credit: amount }]
        : [{ account_id: offset, debit: amount }, { account_id: bank.account_id, credit: amount }]
    });
    const balance = Number(bank.current_balance || 0) + (direction === 'in' ? amount : -amount);
    await supabase.from('banks').update({ current_balance: round(balance) }).eq('id', bank.id);
    const { data, error } = await supabase.from('bank_transactions').insert([{
      bank_id: bank.id, journal_id: journal.id, direction, amount,
      method: req.body.method || 'bank', reference: req.body.reference,
      description: req.body.description, transaction_date: req.body.transaction_date || today(),
      is_reconciled: 0
    }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/banks/transactions/:id/reconcile', financeUser, async (req, res) => {
  const { data, error } = await supabase.from('bank_transactions').update({
    is_reconciled: 1, reconciled_at: new Date().toISOString(), reconciled_by: req.user.id
  }).eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

router.get('/payments', financeViewer, async (_req, res) => {
  const { data, error } = await supabase.from('payments').select('*').order('payment_date', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/payments', financeViewer, async (req, res) => {
  const amount = positiveAmount(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'A positive payment amount is required.' });
  const direction = req.body.direction === 'out' ? 'out' : 'in';
  const cashAccount = Number(req.body.account_id);
  const offsetAccount = Number(req.body.offset_account_id);
  if (!cashAccount || !offsetAccount) return res.status(400).json({ error: 'account_id and offset_account_id are required.' });
  try {
    const journal = await createJournal({
      journalType: direction === 'in' ? 'receipt' : 'payment',
      date: req.body.payment_date, reference: req.body.reference,
      description: req.body.notes || `${direction === 'in' ? 'Payment received' : 'Payment made'}`,
      userId: req.user.id,
      entries: direction === 'in'
        ? [{ account_id: cashAccount, debit: amount }, { account_id: offsetAccount, credit: amount }]
        : [{ account_id: offsetAccount, debit: amount }, { account_id: cashAccount, credit: amount }]
    });
    const { data, error } = await supabase.from('payments').insert([{
      payment_no: `PAY-${Date.now()}`, direction, party_type: req.body.party_type || null,
      party_id: req.body.party_id || null, amount, method: req.body.method || 'cash',
      reference: req.body.reference, payment_date: req.body.payment_date || today(),
      journal_id: journal.id, status: 'completed', notes: req.body.notes,
      created_by: req.user.id
    }]).select();
    if (error) throw error;
    const payment = data[0];
    for (const allocation of req.body.allocations || []) {
      await supabase.from('payment_allocations').insert([{
        payment_id: payment.id, document_type: allocation.document_type,
        document_id: allocation.document_id, amount: Number(allocation.amount) || 0
      }]);
    }
    await emitEvent('finance.payment_posted', 'payment', payment.id, req.user.id, { direction, amount });
    res.status(201).json(payment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/expenses', financeViewer, async (_req, res) => {
  const { data, error } = await supabase.from('expenses').select('*').order('expense_date', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/expenses', financeUser, async (req, res) => {
  const amount = positiveAmount(req.body.amount);
  if (!amount || !req.body.expense_account_id) return res.status(400).json({ error: 'Expense account and positive amount are required.' });
  const status = req.body.status === 'paid' ? 'paid' : 'draft';
  let journalId = null;
  try {
    if (status === 'paid') {
      if (!req.body.payment_account_id) return res.status(400).json({ error: 'payment_account_id is required for paid expenses.' });
      const journal = await createJournal({
        journalType: 'expense', date: req.body.expense_date, reference: req.body.reference,
        description: req.body.description || 'Business expense', userId: req.user.id,
        entries: [
          { account_id: req.body.expense_account_id, debit: amount },
          { account_id: req.body.payment_account_id, credit: amount }
        ]
      });
      journalId = journal.id;
    }
    const { data, error } = await supabase.from('expenses').insert([{
      expense_no: `EXP-${Date.now()}`, supplier_id: req.body.supplier_id || null,
      expense_account_id: req.body.expense_account_id, payment_account_id: req.body.payment_account_id || null,
      amount, tax_amount: Number(req.body.tax_amount) || 0, expense_date: req.body.expense_date || today(),
      description: req.body.description, reference: req.body.reference, status,
      journal_id: journalId, created_by: req.user.id
    }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/gst/summary', financeViewer, async (req, res) => {
  const { data: sales } = await supabase.from('sales').select('*');
  const { data: expenses } = await supabase.from('expenses').select('*');
  const filteredSales = filterByDate(sales || [], req.query.from, req.query.to, 'sale_date');
  const filteredExpenses = filterByDate(expenses || [], req.query.from, req.query.to, 'expense_date');
  const outputTax = filteredSales.reduce((sum, sale) => sum + Number(sale.tax_amount || 0), 0);
  const inputTax = filteredExpenses.reduce((sum, expense) => sum + Number(expense.tax_amount || 0), 0);
  res.json({
    taxable_sales: round(filteredSales.reduce((sum, sale) => sum + Number(sale.subtotal || 0) - Number(sale.discount || 0), 0)),
    output_tax: round(outputTax), input_tax: round(inputTax), net_gst_payable: round(outputTax - inputTax),
    cgst: round(outputTax / 2), sgst: round(outputTax / 2), igst: 0
  });
});

router.get('/reports/trial-balance', financeViewer, async (_req, res) => {
  const report = await accountBalances();
  const rows = report.map(({ account, debit, credit }) => ({ id: account.id, code: account.code, name: account.name, account_type: account.account_type, debit, credit }));
  res.json({ rows, total_debit: round(rows.reduce((sum, row) => sum + row.debit, 0)), total_credit: round(rows.reduce((sum, row) => sum + row.credit, 0)) });
});

router.get('/reports/profit-loss', financeViewer, async (_req, res) => {
  const balances = await accountBalances();
  const income = balances.filter(row => row.account.account_type === 'income').map(row => ({ ...row.account, amount: round(row.credit - row.debit) }));
  const expenses = balances.filter(row => row.account.account_type === 'expense').map(row => ({ ...row.account, amount: round(row.debit - row.credit) }));
  const totalIncome = income.reduce((sum, row) => sum + row.amount, 0);
  const totalExpenses = expenses.reduce((sum, row) => sum + row.amount, 0);
  res.json({ income, expenses, total_income: round(totalIncome), total_expenses: round(totalExpenses), net_profit: round(totalIncome - totalExpenses) });
});

router.get('/reports/balance-sheet', financeViewer, async (_req, res) => {
  const balances = await accountBalances();
  const group = type => balances.filter(row => row.account.account_type === type).map(row => ({
    ...row.account, amount: round(type === 'asset' ? row.debit - row.credit : row.credit - row.debit)
  }));
  const assets = group('asset');
  const liabilities = group('liability');
  const equity = group('equity');
  res.json({
    assets, liabilities, equity,
    total_assets: round(assets.reduce((sum, row) => sum + row.amount, 0)),
    total_liabilities: round(liabilities.reduce((sum, row) => sum + row.amount, 0)),
    total_equity: round(equity.reduce((sum, row) => sum + row.amount, 0))
  });
});

router.get('/reports/cash-flow', financeViewer, async (_req, res) => {
  const { data: accounts } = await supabase.from('accounts').select('*');
  const cashAccounts = (accounts || []).filter(account => account.account_type === 'asset' && /cash|bank/i.test(account.name));
  const ledgers = [];
  for (const account of cashAccounts) {
    const { data: entries } = await supabase.from('journal_entries').select('*').eq('account_id', account.id);
    ledgers.push(...(entries || []));
  }
  const inflow = ledgers.reduce((sum, entry) => sum + Number(entry.debit || 0), 0);
  const outflow = ledgers.reduce((sum, entry) => sum + Number(entry.credit || 0), 0);
  res.json({ inflow: round(inflow), outflow: round(outflow), net_cash_flow: round(inflow - outflow) });
});

router.get('/reports/day-book', financeViewer, async (req, res) => {
  const date = req.query.date || today();
  const { data: journals } = await supabase.from('journals').select('*');
  res.json((journals || []).filter(journal => String(journal.journal_date).slice(0, 10) === date));
});

router.get('/reports/outstanding', financeViewer, async (_req, res) => {
  const { data: customers } = await supabase.from('customers').select('*');
  const { data: suppliers } = await supabase.from('suppliers').select('*');
  res.json({
    receivables: (customers || []).filter(customer => Number(customer.balance) > 0),
    payables: (suppliers || []).filter(supplier => Number(supplier.balance || 0) > 0),
    total_receivable: round((customers || []).reduce((sum, customer) => sum + Math.max(0, Number(customer.balance || 0)), 0)),
    total_payable: round((suppliers || []).reduce((sum, supplier) => sum + Math.max(0, Number(supplier.balance || 0)), 0))
  });
});

router.get('/finance/summary', financeViewer, async (_req, res) => {
  const [profitLoss, cashFlow, outstanding] = await Promise.all([
    buildProfitLoss(), buildCashFlow(), buildOutstanding()
  ]);
  res.json({ ...profitLoss, ...cashFlow, ...outstanding });
});

async function createJournal({ journalType, date, reference, description, entries, userId }) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error('A journal requires at least two entries.');
  const normalized = entries.map(entry => ({
    account_id: Number(entry.account_id),
    debit: Number(entry.debit) || 0,
    credit: Number(entry.credit) || 0,
    description: entry.description || null
  }));
  if (normalized.some(entry => !entry.account_id || entry.debit < 0 || entry.credit < 0 || (entry.debit > 0 && entry.credit > 0))) {
    throw new Error('Each journal line requires an account and either a debit or credit.');
  }
  const debitTotal = round(normalized.reduce((sum, entry) => sum + entry.debit, 0));
  const creditTotal = round(normalized.reduce((sum, entry) => sum + entry.credit, 0));
  if (debitTotal <= 0 || Math.abs(debitTotal - creditTotal) > 0.005) throw new Error('Journal entries must balance.');
  const { data: accounts } = await supabase.from('accounts').select('*');
  const accountIds = new Set((accounts || []).filter(account => !account.is_archived).map(account => Number(account.id)));
  if (normalized.some(entry => !accountIds.has(entry.account_id))) throw new Error('One or more journal accounts are invalid or archived.');
  const { data, error } = await supabase.from('journals').insert([{
    journal_no: `JV-${Date.now()}`, journal_type: journalType, journal_date: date || today(),
    reference, description, total_debit: debitTotal, total_credit: creditTotal,
    status: 'posted', created_by: userId
  }]).select();
  if (error) throw error;
  const journal = data[0];
  for (const entry of normalized) {
    const { error: entryError } = await supabase.from('journal_entries').insert([{ journal_id: journal.id, ...entry }]);
    if (entryError) throw entryError;
  }
  await emitEvent('finance.journal_posted', 'journal', journal.id, userId, { journal_type: journalType, total: debitTotal });
  return { ...journal, entries: normalized };
}

async function accountBalances() {
  const { data: accounts } = await supabase.from('accounts').select('*');
  const { data: entries } = await supabase.from('journal_entries').select('*');
  return (accounts || []).filter(account => !account.is_archived).map(account => {
    const accountEntries = (entries || []).filter(entry => Number(entry.account_id) === Number(account.id));
    const opening = Number(account.opening_balance || 0);
    return {
      account,
      debit: round(accountEntries.reduce((sum, entry) => sum + Number(entry.debit || 0), 0) + Math.max(opening, 0)),
      credit: round(accountEntries.reduce((sum, entry) => sum + Number(entry.credit || 0), 0) + Math.max(-opening, 0))
    };
  });
}

async function buildProfitLoss() {
  const balances = await accountBalances();
  const totalIncome = balances.filter(row => row.account.account_type === 'income').reduce((sum, row) => sum + row.credit - row.debit, 0);
  const totalExpenses = balances.filter(row => row.account.account_type === 'expense').reduce((sum, row) => sum + row.debit - row.credit, 0);
  return { total_income: round(totalIncome), total_expenses: round(totalExpenses), net_profit: round(totalIncome - totalExpenses) };
}

async function buildCashFlow() {
  const { data: accounts } = await supabase.from('accounts').select('*');
  const ids = new Set((accounts || []).filter(account => /cash|bank/i.test(account.name)).map(account => Number(account.id)));
  const { data: entries } = await supabase.from('journal_entries').select('*');
  const cashEntries = (entries || []).filter(entry => ids.has(Number(entry.account_id)));
  const inflow = cashEntries.reduce((sum, entry) => sum + Number(entry.debit || 0), 0);
  const outflow = cashEntries.reduce((sum, entry) => sum + Number(entry.credit || 0), 0);
  return { cash_inflow: round(inflow), cash_outflow: round(outflow), net_cash_flow: round(inflow - outflow) };
}

async function buildOutstanding() {
  const { data: customers } = await supabase.from('customers').select('*');
  const receivable = (customers || []).reduce((sum, customer) => sum + Math.max(0, Number(customer.balance || 0)), 0);
  return { outstanding_receivable: round(receivable) };
}

async function emitEvent(eventType, entityType, entityId, userId, payload) {
  await supabase.from('domain_events').insert([{
    event_type: eventType, entity_type: entityType, entity_id: String(entityId),
    actor_user_id: userId, payload: JSON.stringify(payload)
  }]);
}

function filterByDate(rows, from, to, field) {
  return rows.filter(row => (!from || String(row[field]).slice(0, 10) >= from) && (!to || String(row[field]).slice(0, 10) <= to));
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

const positiveAmount = value => Number(value) > 0 ? round(Number(value)) : 0;
const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export default router;
