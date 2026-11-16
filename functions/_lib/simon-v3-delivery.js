import { jsonResponse, problem, resourceFromRow, isUuid } from './simon-v3.js';

export async function clientContact(db, id) {
  const manual = await db.prepare('SELECT * FROM manual_artists WHERE id = ?').bind(id).first();
  if (manual) {
    if (manual.phone) return manual;
    const application = await db.prepare("SELECT * FROM applications WHERE lower(email) = lower(?) AND status IN ('approved', 'payment_pending', 'confirmed') ORDER BY created_at DESC LIMIT 1")
      .bind(manual.linked_email || manual.email).first();
    return { ...manual, phone: application?.phone || null };
  }
  return db.prepare("SELECT * FROM applications WHERE id = ? AND status IN ('approved', 'payment_pending', 'confirmed')").bind(id).first();
}

export async function readPendingNotifications(context) {
  const result = await context.env.APPLICATIONS_DB.prepare(`SELECT * FROM simon_v3_resources
    WHERE kind = 'notification' AND state = 'queued'
      AND json_extract(data_json, '$.channel') = 'sms'
      AND json_extract(data_json, '$.template') = 'client_outreach'
    ORDER BY created_at ASC LIMIT 10`).all();
  return jsonResponse({ items: (result.results || []).map(resourceFromRow), next_cursor: null });
}

export async function mutateNotificationDelivery(context, route, actor, traceId, key, body) {
  if (!['claimNotification', 'recordNotificationDelivery'].includes(route.operationId)) return null;
  if (!['admin', 'system'].includes(actor.role)) return problem(403, 'forbidden', 'Delivery worker authority required', traceId);
  const db = context.env.APPLICATIONS_DB;
  const row = await db.prepare("SELECT * FROM simon_v3_resources WHERE id = ? AND kind = 'notification'")
    .bind(route.params.notification_id).first();
  if (!row) return problem(404, 'not_found', 'Notification not found', traceId);
  const data = JSON.parse(row.data_json);
  const timestamp = new Date().toISOString();
  if (route.operationId === 'claimNotification') {
    if (row.state !== 'queued' || data.template !== 'client_outreach' || data.channel !== 'sms') {
      return problem(409, 'invalid_transition', 'Notification is not deliverable or already claimed', traceId);
    }
    const contact = await clientContact(db, data.recipient_person_id);
    const digits = String(contact?.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const message = data.variables?.message;
    if (!/^\d{10}$/.test(digits) || typeof message !== 'string' || !message.trim() || message.length > 2000) {
      return problem(409, 'invalid_transition', 'Current client phone or message is unavailable', traceId);
    }
    const claimId = crypto.randomUUID();
    const claimed = { ...data, state: 'sending', claim_id: claimId, claimed_at: timestamp,
      attempts: Number(data.attempts || 0) + 1 };
    const result = await db.prepare(`UPDATE simon_v3_resources SET state = 'sending', data_json = ?,
      version = version + 1, updated_at = ? WHERE id = ? AND state = 'queued' AND version = ?`)
      .bind(JSON.stringify(claimed), timestamp, row.id, row.version).run();
    if (result.meta?.changes !== 1) return problem(409, 'version_conflict', 'Notification already claimed', traceId);
    return jsonResponse({ id: row.id, kind: 'notification_delivery', version: Number(row.version) + 1,
      data: { claim_id: claimId, phone: `+1${digits}`, message }, evidence_refs: [] });
  }
  const receipt = body.data.provider_receipt;
  if (!isUuid(body.data.claim_id) || body.data.claim_id !== data.claim_id
      || !['sending', 'delivered'].includes(row.state)) return problem(409, 'version_conflict', 'Delivery claim does not match', traceId);
  if (row.state === 'delivered') return jsonResponse(resourceFromRow(row));
  const delivered = typeof receipt === 'string' && receipt.length > 0 && receipt.length < 1024;
  const next = { ...data, state: delivered ? 'delivered' : 'attention_required',
    delivered_at: delivered ? timestamp : null, provider_receipt: delivered ? receipt : null,
    last_error_code: delivered ? null : 'delivery_not_confirmed' };
  // A send without a receipt may already exist at Apple. Never auto-repeat it.
  await db.prepare('UPDATE simon_v3_resources SET state = ?, data_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = \'sending\'')
    .bind(next.state, JSON.stringify(next), timestamp, row.id).run();
  return jsonResponse({ id: row.id, kind: 'notification', version: Number(row.version) + 1, data: next, evidence_refs: [] });
}
