import express from 'express';
import { supabase } from '../config/supabase.js';
import { checkRole } from './auth.js';
import {
  collectBusinessContext,
  buildInventoryForecast,
  buildBusinessHealth,
  buildInsights,
  generateCopilotResponse,
  rankKnowledge
} from '../src/services/aiBusinessService.js';

const router = express.Router();
const aiUser = checkRole(['admin', 'manager', 'cashier', 'warehouse_staff']);
const aiManager = checkRole(['admin', 'manager']);
const requestWindows = new Map();

router.get('/status', aiUser, (_req, res) => {
  res.json({
    provider: process.env.OPENAI_API_KEY ? 'openai' : 'local',
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    fallback_available: true,
    action_policy: 'preview_then_approve'
  });
});

router.post('/chat', aiUser, rateLimit, async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message || message.length > 4000) {
    return res.status(400).json({ error: 'Message must contain between 1 and 4,000 characters.' });
  }
  try {
    const conversation = await resolveConversation(req.body.conversation_id, req.user.id, message);
    const userMessage = await insertOne('ai_messages', {
      conversation_id: conversation.id,
      role: 'user',
      content: message,
      metadata: JSON.stringify({ source: req.body.source || 'assistant' })
    });
    const context = await collectBusinessContext();
    const { data: knowledgeRows } = await supabase.from('ai_knowledge_documents').select('*');
    const knowledge = rankKnowledge((knowledgeRows || []).filter(item => item.status === 'active'), message);
    const response = await generateCopilotResponse({ message, context, user: req.user, knowledge });
    const assistantMessage = await insertOne('ai_messages', {
      conversation_id: conversation.id,
      role: 'assistant',
      content: response.answer,
      metadata: JSON.stringify({
        provider: response.provider,
        fallback: response.fallback,
        model: response.model,
        cards: response.cards,
        sources: response.sources
      })
    });
    const proposals = [];
    for (const action of response.proposed_actions || []) {
      if (!supportedAction(action.type)) continue;
      const proposal = await insertOne('ai_action_proposals', {
        conversation_id: conversation.id,
        message_id: assistantMessage.id,
        action_type: action.type,
        title: action.title,
        reason: action.reason,
        payload: JSON.stringify(action.payload || parseJson(action.payload_json) || {}),
        status: 'pending',
        proposed_by: req.user.id,
        expires_at: new Date(Date.now() + 24 * 3600000).toISOString()
      });
      proposals.push(publicProposal(proposal));
    }
    for (const source of response.sources || []) {
      await insertOne('ai_tool_calls', {
        conversation_id: conversation.id,
        message_id: assistantMessage.id,
        tool_name: `read_${source.type}`,
        arguments: JSON.stringify({ record_ids: source.record_ids }),
        result_summary: source.label,
        status: 'completed',
        created_by: req.user.id
      });
    }
    await insertOne('ai_usage_records', {
      conversation_id: conversation.id,
      user_id: req.user.id,
      provider: response.provider,
      model: response.model,
      input_tokens: Number(response.usage?.input_tokens || 0),
      output_tokens: Number(response.usage?.output_tokens || 0),
      latency_ms: response.latency_ms,
      fallback_used: response.fallback ? 1 : 0,
      error_code: response.provider_error?.code || null
    });
    await supabase.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversation.id);
    res.json({
      conversation_id: conversation.id,
      message_id: assistantMessage.id,
      answer: response.answer,
      sources: response.sources || [],
      cards: response.cards || [],
      proposed_actions: proposals,
      provider: response.provider,
      fallback: response.fallback,
      model: response.model,
      latency_ms: response.latency_ms,
      provider_error: response.provider_error || null,
      user_message_id: userMessage.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/conversations', aiUser, async (req, res) => {
  const { data, error } = await supabase.from('ai_conversations').select('*').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/conversations/:id', aiUser, async (req, res) => {
  const { data: conversation } = await supabase.from('ai_conversations').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  const { data: messages } = await supabase.from('ai_messages').select('*').eq('conversation_id', conversation.id).order('created_at');
  const { data: proposals } = await supabase.from('ai_action_proposals').select('*').eq('conversation_id', conversation.id).order('created_at');
  res.json({
    ...conversation,
    messages: (messages || []).map(message => ({ ...message, metadata: parseJson(message.metadata) })),
    proposed_actions: (proposals || []).map(publicProposal)
  });
});

router.get('/insights', aiUser, async (_req, res) => {
  try {
    res.json(buildInsights(await collectBusinessContext()));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/business-health', aiUser, async (_req, res) => {
  try {
    res.json(buildBusinessHealth(await collectBusinessContext()));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/forecast/inventory', aiUser, async (req, res) => {
  try {
    const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
    const items = buildInventoryForecast(await collectBusinessContext(), days);
    res.json({ days, generated_at: new Date().toISOString(), items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reorder-recommendations', aiUser, async (req, res) => {
  try {
    const items = buildInventoryForecast(await collectBusinessContext(), Number(req.query.days) || 30)
      .filter(item => item.reorder_quantity > 0);
    res.json({ count: items.length, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/actions', aiUser, async (req, res) => {
  const { data, error } = await supabase.from('ai_action_proposals').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  const visible = ['admin', 'manager'].includes(req.user.role)
    ? data
    : data.filter(item => Number(item.proposed_by) === Number(req.user.id));
  res.json(visible.filter(item => !req.query.status || item.status === req.query.status).map(publicProposal));
});

router.post('/actions/:id/approve', aiManager, async (req, res) => {
  const { data: proposal } = await supabase.from('ai_action_proposals').select('*').eq('id', req.params.id).single();
  if (!proposal) return res.status(404).json({ error: 'AI action proposal not found.' });
  if (proposal.status !== 'pending') return res.status(409).json({ error: `This proposal is already ${proposal.status}.` });
  if (new Date(proposal.expires_at).getTime() < Date.now()) {
    await supabase.from('ai_action_proposals').update({ status: 'expired' }).eq('id', proposal.id).eq('status', 'pending');
    return res.status(409).json({ error: 'This proposal has expired.' });
  }
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase.from('ai_action_proposals')
    .update({ status: 'executing', last_attempt_at: claimedAt })
    .eq('id', proposal.id)
    .eq('status', 'pending')
    .select();
  if (claimError) return res.status(500).json({ error: claimError.message });
  if (!claimed?.[0]) return res.status(409).json({ error: 'This proposal is already being processed or is no longer pending.' });
  try {
    const result = await executeApprovedAction(claimed[0], req.user);
    const { data } = await supabase.from('ai_action_proposals').update({
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date().toISOString(),
      execution_result: JSON.stringify(result)
    }).eq('id', proposal.id).eq('status', 'executing').select();
    await emitEvent('ai.action_approved', 'ai_action_proposal', proposal.id, req.user.id, { action_type: proposal.action_type, result });
    res.json({ proposal: publicProposal(data[0]), result });
  } catch (error) {
    await supabase.from('ai_action_proposals').update({
      status: 'pending',
      execution_error: error.message,
      last_attempt_at: new Date().toISOString()
    }).eq('id', proposal.id).eq('status', 'executing');
    res.status(400).json({ error: error.message });
  }
});

router.post('/actions/:id/reject', aiManager, async (req, res) => {
  const { data: proposal } = await supabase.from('ai_action_proposals').select('*').eq('id', req.params.id).single();
  if (!proposal) return res.status(404).json({ error: 'AI action proposal not found.' });
  if (proposal.status !== 'pending') return res.status(409).json({ error: `This proposal is already ${proposal.status}.` });
  const { data, error } = await supabase.from('ai_action_proposals').update({
    status: 'rejected',
    rejected_by: req.user.id,
    rejected_at: new Date().toISOString(),
    rejection_reason: String(req.body.reason || '').slice(0, 500)
  }).eq('id', proposal.id).eq('status', 'pending').select();
  if (error) return res.status(400).json({ error: error.message });
  if (!data?.[0]) return res.status(409).json({ error: 'This proposal is already being processed or is no longer pending.' });
  await emitEvent('ai.action_rejected', 'ai_action_proposal', proposal.id, req.user.id, { action_type: proposal.action_type });
  res.json(publicProposal(data[0]));
});

router.get('/knowledge', aiUser, async (req, res) => {
  const { data, error } = await supabase.from('ai_knowledge_documents').select('*').order('updated_at', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  const query = String(req.query.q || '').toLowerCase();
  res.json(data.filter(item => !query || `${item.title} ${item.tags || ''} ${item.content}`.toLowerCase().includes(query)));
});

router.post('/knowledge', aiManager, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '').trim();
  if (!title || !content || content.length > 100000) {
    return res.status(400).json({ error: 'Title and content are required; content may not exceed 100,000 characters.' });
  }
  try {
    const row = await insertOne('ai_knowledge_documents', {
      title,
      content,
      tags: normalizeTags(req.body.tags),
      source_type: req.body.source_type || 'manual',
      source_reference: req.body.source_reference || null,
      status: 'active',
      created_by: req.user.id,
      updated_at: new Date().toISOString()
    });
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/knowledge/:id', aiManager, async (req, res) => {
  const updates = {};
  if (req.body.title !== undefined) updates.title = String(req.body.title).trim();
  if (req.body.content !== undefined) updates.content = String(req.body.content).trim();
  if (req.body.tags !== undefined) updates.tags = normalizeTags(req.body.tags);
  if (req.body.status !== undefined) updates.status = ['active', 'archived'].includes(req.body.status) ? req.body.status : 'active';
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('ai_knowledge_documents').update(updates).eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  if (!data[0]) return res.status(404).json({ error: 'Knowledge document not found.' });
  res.json(data[0]);
});

router.delete('/knowledge/:id', aiManager, async (req, res) => {
  const { data, error } = await supabase.from('ai_knowledge_documents').delete().eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, document: data[0] || null });
});

async function executeApprovedAction(proposal, user) {
  const payload = parseJson(proposal.payload) || {};
  switch (proposal.action_type) {
    case 'purchase_order':
      return createPurchaseOrder(payload, user);
    case 'stock_transfer':
      return createStockTransfer(payload, user);
    case 'invoice':
      return createDraftInvoice(payload, user);
    case 'payment':
      return createPayment(payload, user);
    case 'automation':
      return createAutomation(payload, user);
    default:
      throw new Error('This AI action type is not supported.');
  }
}

async function createPurchaseOrder(payload, user) {
  if (!payload.supplier_id || !payload.warehouse_id || !Array.isArray(payload.items) || !payload.items.length) {
    throw new Error('Supplier, warehouse, and at least one purchase item are required.');
  }
  const supplier = await findOne('suppliers', payload.supplier_id);
  const warehouse = await findOne('warehouses', payload.warehouse_id);
  if (!supplier || !warehouse) throw new Error('Supplier or warehouse no longer exists.');
  let total = 0;
  const items = [];
  for (const item of payload.items) {
    const product = await findOne('products', item.product_id);
    const quantity = Number(item.quantity);
    const unitCost = Number(item.unit_cost);
    if (!product || quantity <= 0 || unitCost < 0) throw new Error('Every purchase item must reference a valid product, quantity, and unit cost.');
    total += quantity * unitCost;
    items.push({ product_id: product.id, quantity, unit_cost: unitCost });
  }
  const order = await insertOne('purchase_orders', {
    order_no: `PO-AI-${Date.now()}`,
    supplier_id: supplier.id,
    warehouse_id: warehouse.id,
    status: 'draft',
    expected_date: payload.expected_date || null,
    notes: payload.notes || 'Drafted by Inventia Business Copilot',
    total: round(total),
    created_by: user.id
  });
  for (const item of items) {
    await insertOne('purchase_order_items', {
      purchase_order_id: order.id,
      product_id: item.product_id,
      quantity: item.quantity,
      received_quantity: 0,
      unit_cost: item.unit_cost,
      line_total: round(item.quantity * item.unit_cost)
    });
  }
  return { entity_type: 'purchase_order', id: order.id, order_no: order.order_no, total: order.total, status: order.status };
}

async function createStockTransfer(payload, user) {
  const quantity = Number(payload.quantity);
  if (!payload.product_id || !payload.from_warehouse_id || !payload.to_warehouse_id || quantity <= 0) {
    throw new Error('Product, source warehouse, destination warehouse, and positive quantity are required.');
  }
  if (Number(payload.from_warehouse_id) === Number(payload.to_warehouse_id)) throw new Error('Source and destination warehouses must differ.');
  const { data: stock } = await supabase.from('warehouse_stock').select('*')
    .eq('warehouse_id', payload.from_warehouse_id).eq('product_id', payload.product_id).maybeSingle();
  if (!stock || Number(stock.quantity) < quantity) throw new Error('Available stock is insufficient for this transfer.');
  const transfer = await insertOne('stock_transfers', {
    from_warehouse_id: payload.from_warehouse_id,
    to_warehouse_id: payload.to_warehouse_id,
    product_id: payload.product_id,
    quantity,
    status: 'pending',
    requested_by: user.id
  });
  return { entity_type: 'stock_transfer', id: transfer.id, status: transfer.status };
}

async function createDraftInvoice(payload, user) {
  if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('At least one invoice item is required.');
  let subtotal = 0;
  let tax = 0;
  const items = [];
  for (const item of payload.items) {
    const product = await findOne('products', item.product_id);
    const qty = Number(item.qty || item.quantity);
    const rate = Number(item.rate ?? product?.selling_price);
    const taxPercent = Number(item.tax_percent ?? 18);
    if (!product || qty <= 0 || rate < 0 || taxPercent < 0) throw new Error('Invoice items must reference valid products, quantities, prices, and taxes.');
    const taxable = qty * rate;
    const taxAmount = taxable * taxPercent / 100;
    subtotal += taxable;
    tax += taxAmount;
    items.push({ product, qty, rate, taxPercent, taxAmount, lineTotal: taxable + taxAmount });
  }
  if (payload.customer_id && !await findOne('customers', payload.customer_id)) throw new Error('Customer no longer exists.');
  const invoice = await insertOne('invoices', {
    invoiceNumber: `INV-AI-${Date.now()}`,
    customerId: payload.customer_id || null,
    saleId: null,
    subtotal: round(subtotal),
    cgst: round(tax / 2),
    sgst: round(tax / 2),
    igst: 0,
    discount: Number(payload.discount || 0),
    grandTotal: round(subtotal + tax - Number(payload.discount || 0)),
    paymentStatus: 'draft',
    pdfPath: null
  });
  for (const item of items) {
    await insertOne('invoice_items', {
      invoiceId: invoice.id,
      productId: item.product.id,
      hsn: item.product.hsn || '9983',
      qty: item.qty,
      rate: item.rate,
      taxPercent: item.taxPercent,
      taxAmount: round(item.taxAmount),
      lineTotal: round(item.lineTotal)
    }, 'invoiceItemId');
  }
  return { entity_type: 'invoice', id: invoice.id, invoice_number: invoice.invoiceNumber, total: invoice.grandTotal, status: 'draft', created_by: user.id };
}

async function createPayment(payload, user) {
  const amount = Number(payload.amount);
  if (amount <= 0 || !payload.account_id || !payload.offset_account_id) {
    throw new Error('Positive amount, account_id, and offset_account_id are required.');
  }
  const cashAccount = await findOne('accounts', payload.account_id);
  const offsetAccount = await findOne('accounts', payload.offset_account_id);
  if (!cashAccount || !offsetAccount || cashAccount.is_archived || offsetAccount.is_archived) throw new Error('Payment accounts are invalid or archived.');
  const direction = payload.direction === 'out' ? 'out' : 'in';
  const journal = await insertOne('journals', {
    journal_no: `JV-AI-${Date.now()}`,
    journal_type: direction === 'in' ? 'receipt' : 'payment',
    journal_date: new Date().toISOString().slice(0, 10),
    reference: payload.reference || null,
    description: payload.notes || 'Approved AI payment proposal',
    total_debit: amount,
    total_credit: amount,
    status: 'posted',
    created_by: user.id
  });
  const entries = direction === 'in'
    ? [{ account_id: cashAccount.id, debit: amount, credit: 0 }, { account_id: offsetAccount.id, debit: 0, credit: amount }]
    : [{ account_id: offsetAccount.id, debit: amount, credit: 0 }, { account_id: cashAccount.id, debit: 0, credit: amount }];
  for (const entry of entries) await insertOne('journal_entries', { journal_id: journal.id, ...entry });
  const payment = await insertOne('payments', {
    payment_no: `PAY-AI-${Date.now()}`,
    direction,
    party_type: payload.party_type || null,
    party_id: payload.party_id || null,
    amount,
    method: payload.method || 'cash',
    reference: payload.reference || null,
    payment_date: new Date().toISOString().slice(0, 10),
    journal_id: journal.id,
    status: 'completed',
    notes: payload.notes || 'Approved through Inventia Business Copilot',
    created_by: user.id
  });
  return { entity_type: 'payment', id: payment.id, payment_no: payment.payment_no, amount, status: payment.status };
}

async function createAutomation(payload, user) {
  if (!payload.name || !payload.trigger_type || !payload.action_type) throw new Error('Automation name, trigger, and action are required.');
  const automation = await insertOne('ai_automations', {
    name: String(payload.name).slice(0, 160),
    description: String(payload.description || '').slice(0, 1000),
    trigger_type: payload.trigger_type,
    trigger_config: JSON.stringify(payload.trigger_config || {}),
    action_type: payload.action_type,
    action_config: JSON.stringify(payload.action_config || {}),
    status: 'active',
    created_by: user.id
  });
  return { entity_type: 'automation', id: automation.id, name: automation.name, status: automation.status };
}

async function resolveConversation(id, userId, message) {
  if (id) {
    const { data } = await supabase.from('ai_conversations').select('*').eq('id', id).eq('user_id', userId).single();
    if (data) return data;
  }
  return insertOne('ai_conversations', {
    user_id: userId,
    title: message.slice(0, 80),
    status: 'active',
    updated_at: new Date().toISOString()
  });
}

async function insertOne(table, value, idColumn = 'id') {
  const { data, error } = await supabase.from(table).insert([value]).select();
  if (error) throw error;
  if (data?.[0]) return data[0];
  const { data: rows } = await supabase.from(table).select('*').order(idColumn, { ascending: false }).limit(1);
  return rows?.[0];
}

async function findOne(table, id) {
  const { data } = await supabase.from(table).select('*').eq('id', id).single();
  return data;
}

async function emitEvent(eventType, entityType, entityId, userId, payload) {
  await insertOne('domain_events', {
    event_type: eventType,
    entity_type: entityType,
    entity_id: String(entityId),
    actor_user_id: userId,
    payload: JSON.stringify(payload)
  });
}

function rateLimit(req, res, next) {
  const key = String(req.user.id);
  const now = Date.now();
  const recent = (requestWindows.get(key) || []).filter(time => now - time < 60000);
  if (recent.length >= 20) return res.status(429).json({ error: 'AI request limit reached. Try again in a minute.' });
  recent.push(now);
  requestWindows.set(key, recent);
  next();
}

function publicProposal(proposal) {
  if (!proposal) return null;
  return {
    ...proposal,
    payload: parseJson(proposal.payload) || {},
    execution_result: parseJson(proposal.execution_result)
  };
}

function supportedAction(type) {
  return ['purchase_order', 'invoice', 'stock_transfer', 'payment', 'automation'].includes(type);
}

function normalizeTags(tags) {
  return (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map(tag => String(tag).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20)
    .join(',');
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export default router;
