import {
  buildBusinessHealth,
  buildInsights,
  buildInventoryForecast,
  generateCopilotResponse,
  rankKnowledge,
  searchBusiness
} from './aiBusinessService.js';
import { createTradeDocument, transferStock } from './enterpriseTradeService.js';
import { httpError, parseJson, writeTenantAudit } from '../platform/phase5Http.js';

export async function collectTenantBusinessContext(db) {
  const [products, stock, sales, saleItems, customers, suppliers, warehouses, payments, accounts, entries] = await Promise.all([
    safeAll(db, 'SELECT * FROM products'),
    safeAll(db, 'SELECT * FROM warehouse_stock'),
    safeAll(db, 'SELECT * FROM sales'),
    safeAll(db, 'SELECT * FROM sale_items'),
    safeAll(db, 'SELECT * FROM customers'),
    safeAll(db, 'SELECT * FROM suppliers'),
    safeAll(db, 'SELECT * FROM warehouses'),
    safeAll(db, 'SELECT * FROM payments'),
    safeAll(db, 'SELECT * FROM accounts'),
    safeAll(db, 'SELECT * FROM journal_entries')
  ]);
  const stockByProduct = new Map();
  for (const row of stock) stockByProduct.set(Number(row.product_id), (stockByProduct.get(Number(row.product_id)) || 0) + Number(row.quantity || 0));
  const enrichedProducts = products.map(product => ({ ...product, stock: stockByProduct.get(Number(product.id)) || 0 }));
  return {
    products: enrichedProducts,
    productMap: new Map(enrichedProducts.map(product => [Number(product.id), product])),
    stock, sales, saleItems, customers, suppliers, warehouses, payments, accounts, entries
  };
}

export async function tenantAiChat(db, input, req) {
  const actorId = req.user.tenant_user_id || req.user.id;
  let conversation;
  if (input.conversation_id) {
    conversation = await db.one('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?', [input.conversation_id, actorId]);
    if (!conversation) throw httpError(404, 'conversation_not_found', 'AI conversation was not found.');
  } else {
    const inserted = await insertWithId(db,
      `INSERT INTO ai_conversations (user_id, title, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
      [actorId, input.message.slice(0, 80), now(), now()]
    );
    conversation = await db.one('SELECT * FROM ai_conversations WHERE id = ?', [inserted.id || inserted.rows?.[0]?.id]);
  }
  const userInsert = await insertWithId(db,
    `INSERT INTO ai_messages (conversation_id, role, content, metadata, created_at)
     VALUES (?, 'user', ?, ?, ?)`,
    [conversation.id, input.message, JSON.stringify({ source: input.source || 'assistant' }), now()]
  );
  const context = await collectTenantBusinessContext(db);
  const knowledgeRows = await db.all(`SELECT * FROM ai_knowledge_documents WHERE status = 'active' ORDER BY updated_at DESC`);
  const knowledge = rankKnowledge(knowledgeRows, input.message);
  const response = await generateCopilotResponse({ message: input.message, context, user: req.user, knowledge });
  const assistantInsert = await insertWithId(db,
    `INSERT INTO ai_messages (conversation_id, role, content, metadata, created_at)
     VALUES (?, 'assistant', ?, ?, ?)`,
    [conversation.id, response.answer, JSON.stringify({
      provider: response.provider, fallback: response.fallback, model: response.model,
      cards: response.cards, sources: response.sources
    }), now()]
  );
  const assistantId = assistantInsert.id || assistantInsert.rows?.[0]?.id;
  const proposals = [];
  for (const action of response.proposed_actions || []) {
    if (!['purchase_order', 'invoice', 'stock_transfer'].includes(action.type)) continue;
    const inserted = await insertWithId(db,
      `INSERT INTO ai_action_proposals
        (conversation_id, message_id, action_type, title, reason, payload, status,
         proposed_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        conversation.id, assistantId, action.type, action.title, action.reason || null,
        JSON.stringify(action.payload || {}), actorId,
        new Date(Date.now() + 86400000).toISOString(), now()
      ]
    );
    proposals.push(await db.one('SELECT * FROM ai_action_proposals WHERE id = ?', [inserted.id || inserted.rows?.[0]?.id]));
  }
  for (const source of response.sources || []) {
    await db.run(
      `INSERT INTO ai_tool_calls
        (conversation_id, message_id, tool_name, arguments, result_summary, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
      [conversation.id, assistantId, `read_${source.type}`, JSON.stringify({ record_ids: source.record_ids }), source.label, actorId, now()]
    );
  }
  await db.run(
    `INSERT INTO ai_usage_records
      (conversation_id, user_id, provider, model, input_tokens, output_tokens,
       latency_ms, fallback_used, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      conversation.id, actorId, response.provider, response.model,
      Number(response.usage?.input_tokens || 0), Number(response.usage?.output_tokens || 0),
      response.latency_ms, response.fallback ? 1 : 0, response.provider_error?.code || null, now()
    ]
  );
  await db.run('UPDATE ai_conversations SET updated_at = ? WHERE id = ?', [now(), conversation.id]);
  await writeTenantAudit(db, req, {
    eventType: 'ai.chat_completed',
    entityType: 'ai_conversation',
    entityId: conversation.id,
    metadata: { provider: response.provider, fallback: response.fallback, proposal_count: proposals.length }
  });
  return {
    conversation_id: conversation.id,
    message_id: assistantId,
    user_message_id: userInsert.id || userInsert.rows?.[0]?.id,
    answer: response.answer,
    sources: response.sources || [],
    cards: response.cards || [],
    proposed_actions: proposals.map(publicProposal),
    provider: response.provider,
    fallback: response.fallback,
    model: response.model,
    latency_ms: response.latency_ms,
    provider_error: response.provider_error || null
  };
}

export async function listTenantAiConversations(db, req) {
  return db.all(
    'SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100',
    [req.user.tenant_user_id || req.user.id]
  );
}

export async function getTenantAiConversation(db, id, req) {
  const conversation = await db.one(
    'SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?',
    [id, req.user.tenant_user_id || req.user.id]
  );
  if (!conversation) throw httpError(404, 'conversation_not_found', 'AI conversation was not found.');
  const [messages, proposals] = await Promise.all([
    db.all('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at, id', [id]),
    db.all('SELECT * FROM ai_action_proposals WHERE conversation_id = ? ORDER BY created_at, id', [id])
  ]);
  return {
    ...conversation,
    messages: messages.map(row => ({ ...row, metadata: parseJson(row.metadata, {}) })),
    proposed_actions: proposals.map(publicProposal)
  };
}

export async function tenantAiAnalytics(db, type, days = 30) {
  const context = await collectTenantBusinessContext(db);
  if (type === 'insights') return buildInsights(context);
  if (type === 'health') return buildBusinessHealth(context);
  const items = buildInventoryForecast(context, days);
  return type === 'reorder' ? { count: items.filter(item => item.reorder_quantity > 0).length, items: items.filter(item => item.reorder_quantity > 0) } : { days, generated_at: now(), items };
}

export async function searchTenantBusiness(db, query) {
  return searchBusiness(query, await collectTenantBusinessContext(db));
}

export async function listTenantAiActions(db, status, req) {
  const rows = await db.all('SELECT * FROM ai_action_proposals ORDER BY created_at DESC LIMIT 200');
  const visible = ['admin', 'manager'].includes(req.user.role)
    ? rows
    : rows.filter(row => String(row.proposed_by) === String(req.user.tenant_user_id || req.user.id));
  return visible.filter(row => !status || row.status === status).map(publicProposal);
}

export async function approveTenantAiAction(db, id, req) {
  const proposal = await db.transaction(async tx => {
    const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const row = await tx.one(`SELECT * FROM ai_action_proposals WHERE id = ?${lock}`, [id]);
    if (!row) throw httpError(404, 'ai_action_not_found', 'AI action proposal was not found.');
    if (row.status !== 'pending') throw httpError(409, 'ai_action_already_decided', `This proposal is already ${row.status}.`);
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await tx.run(`UPDATE ai_action_proposals SET status = 'expired' WHERE id = ?`, [id]);
      throw httpError(409, 'ai_action_expired', 'This proposal has expired.');
    }
    await tx.run(`UPDATE ai_action_proposals SET status = 'executing', last_attempt_at = ? WHERE id = ?`, [now(), id]);
    return { ...row, payload: parseJson(row.payload, {}) };
  });
  try {
    let result;
    if (proposal.action_type === 'purchase_order') {
      result = await createTradeDocument(db, 'purchase-orders', {
        party_id: proposal.payload.supplier_id,
        warehouse_id: proposal.payload.warehouse_id,
        notes: `Created from approved AI proposal #${proposal.id}.`,
        lines: (proposal.payload.items || []).map(item => ({
          product_id: item.product_id,
          quantity: item.quantity,
          unit_price: item.unit_cost || 0
        }))
      }, req);
    } else if (proposal.action_type === 'invoice') {
      result = await createTradeDocument(db, 'invoices', proposal.payload, req);
    } else if (proposal.action_type === 'stock_transfer') {
      result = await transferStock(db, proposal.payload, req);
    } else {
      throw httpError(422, 'unsupported_ai_action', 'This AI action type is not supported.');
    }
    await db.run(
      `UPDATE ai_action_proposals SET status = 'approved', approved_by = ?, approved_at = ?,
       execution_result = ?, execution_error = NULL WHERE id = ? AND status = 'executing'`,
      [req.user.tenant_user_id || req.user.id, now(), JSON.stringify(result), id]
    );
    return { proposal: publicProposal(await db.one('SELECT * FROM ai_action_proposals WHERE id = ?', [id])), result };
  } catch (error) {
    await db.run(
      `UPDATE ai_action_proposals SET status = 'pending', execution_error = ?, last_attempt_at = ?
       WHERE id = ? AND status = 'executing'`,
      [error.message, now(), id]
    );
    throw error;
  }
}

export async function rejectTenantAiAction(db, id, reason, req) {
  const proposal = await db.one('SELECT * FROM ai_action_proposals WHERE id = ?', [id]);
  if (!proposal) throw httpError(404, 'ai_action_not_found', 'AI action proposal was not found.');
  if (proposal.status !== 'pending') throw httpError(409, 'ai_action_already_decided', `This proposal is already ${proposal.status}.`);
  await db.run(
    `UPDATE ai_action_proposals SET status = 'rejected', rejected_by = ?, rejected_at = ?, rejection_reason = ?
     WHERE id = ? AND status = 'pending'`,
    [req.user.tenant_user_id || req.user.id, now(), String(reason || '').slice(0, 500), id]
  );
  return publicProposal(await db.one('SELECT * FROM ai_action_proposals WHERE id = ?', [id]));
}

export async function listKnowledge(db, query = '') {
  const rows = await db.all('SELECT * FROM ai_knowledge_documents ORDER BY updated_at DESC LIMIT 500');
  const needle = query.toLowerCase();
  return rows.filter(row => !needle || `${row.title} ${row.tags || ''} ${row.content}`.toLowerCase().includes(needle));
}

export async function createKnowledge(db, input, req) {
  const inserted = await insertWithId(db,
    `INSERT INTO ai_knowledge_documents
      (title, content, tags, source_type, source_reference, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [input.title, input.content, normalizeTags(input.tags), input.source_type || 'manual',
      input.source_reference || null, req.user.tenant_user_id || req.user.id, now(), now()]
  );
  return db.one('SELECT * FROM ai_knowledge_documents WHERE id = ?', [inserted.id || inserted.rows?.[0]?.id]);
}

export async function updateKnowledge(db, id, input) {
  const current = await db.one('SELECT * FROM ai_knowledge_documents WHERE id = ?', [id]);
  if (!current) throw httpError(404, 'knowledge_not_found', 'Knowledge document was not found.');
  const result = await db.run(
    `UPDATE ai_knowledge_documents SET title = ?, content = ?, tags = ?, source_type = ?,
     source_reference = ?, status = ?, updated_at = ? WHERE id = ?`,
    [input.title ?? current.title, input.content ?? current.content,
      input.tags === undefined ? current.tags : normalizeTags(input.tags),
      input.source_type ?? current.source_type,
      input.source_reference === undefined ? current.source_reference : input.source_reference,
      input.status ?? current.status, now(), id]
  );
  if (!result.changes) throw httpError(404, 'knowledge_not_found', 'Knowledge document was not found.');
  return db.one('SELECT * FROM ai_knowledge_documents WHERE id = ?', [id]);
}

export async function deleteKnowledge(db, id) {
  const result = await db.run('DELETE FROM ai_knowledge_documents WHERE id = ?', [id]);
  if (!result.changes) throw httpError(404, 'knowledge_not_found', 'Knowledge document was not found.');
}

function publicProposal(row) {
  return { ...row, payload: parseJson(row.payload, {}), execution_result: parseJson(row.execution_result, null) };
}

function insertWithId(db, sql, params) {
  return db.run(`${sql}${db.dialect === 'postgres' ? ' RETURNING id' : ''}`, params);
}

async function safeAll(db, sql) {
  try { return await db.all(sql); } catch (error) {
    if (/no such table|does not exist/i.test(error.message)) return [];
    throw error;
  }
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).map(value => value.trim()).filter(Boolean).join(',');
  return String(tags || '').split(',').map(value => value.trim()).filter(Boolean).join(',');
}

function now() {
  return new Date().toISOString();
}
