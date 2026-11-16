import { jsonResponse, problem, hasOnlyKeys, operationFromRow } from './simon-v3.js';
import { calendarIsConfigured, getBusyPeriods, updateCalendarEvent, createCalendarEvent, deleteCalendarEvent } from './google-calendar.js';
import { decisionEmailIsConfigured, sendDecisionEmail } from './decision-email.js';
import { serviceById } from './service-catalog.js';

const stamp = () => new Date().toISOString();
const decisionOperations = new Set(['approveApplicationWithDeposit', 'approveApplicationWithWaiver', 'declineApplication']);

// The application's native row is the business record. V3 operations supply audit
// and recovery evidence, never a competing application or payment snapshot.
export async function mutateLiveApplication(context, route, actor, traceId, key, requestHash, body) {
  if (!decisionOperations.has(route.operationId)
      && !['archiveApplication', 'restoreApplication'].includes(route.operationId)) return null;
  if (!['admin', 'system'].includes(actor.role)) return problem(403, 'forbidden', 'Administrator authority required', traceId);
  const db = context.env.APPLICATIONS_DB;
  const row = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(route.params.application_id).first();
  if (!row) return null; // Existing isolated staging fixtures remain supported.
  const version = Number(row.simon_version || 1);
  const id = crypto.randomUUID();
  const timestamp = stamp();
  const refs = [{ kind: 'application', id: row.id, version: version + 1 }];
  const steps = [];
  const writeOperation = (status, after, completed = null) => db.prepare(`INSERT INTO simon_v3_operations
    (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role,
     status, resource_refs_json, steps_json, rollback_json, before_json, after_json, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{"available":false}', ?, ?, ?, ?)`)
    .bind(id, route.operationId, key, requestHash, traceId, actor.person_id, actor.role, status,
      JSON.stringify(refs), JSON.stringify(steps), JSON.stringify(row), after, timestamp, completed);
  const response = async () => jsonResponse(operationFromRow(
    await db.prepare('SELECT * FROM simon_v3_operations WHERE id = ?').bind(id).first()), 202);

  if (['archiveApplication', 'restoreApplication'].includes(route.operationId)) {
    if (!hasOnlyKeys(body.data, [])) return problem(400, 'validation_error', 'Archive requires no data fields', traceId);
    const archivedAt = route.operationId === 'archiveApplication' ? timestamp : null;
    await writeOperation('running', null).run();
    const result = await db.prepare(`UPDATE applications SET archived_at = ?, archive_reason = ?,
      simon_version = simon_version + 1 WHERE id = ? AND simon_version = ?`)
      .bind(archivedAt, archivedAt ? body.reason : null, row.id, version).run();
    if (result.meta?.changes !== 1) {
      await db.prepare("UPDATE simon_v3_operations SET status = 'failed', completed_at = ? WHERE id = ?").bind(stamp(), id).run();
      return problem(409, 'version_conflict', 'Application changed before archival', traceId);
    }
    steps.push({ name: 'application_archive_visibility', status: 'succeeded', provider_confirmed: true,
      provider_receipt_ref: row.id, retry_safe: true, error: null });
    await db.prepare("UPDATE simon_v3_operations SET status = 'succeeded', steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?")
      .bind(JSON.stringify(steps), JSON.stringify({ archived_at: archivedAt, status: row.status }), stamp(), id).run();
    return response();
  }

  if (!['new', 'reviewing'].includes(row.status) || row.archived_at) {
    return problem(409, 'invalid_transition', 'Only an active awaiting application can be decided', traceId);
  }
  const decline = route.operationId === 'declineApplication';
  const waiver = route.operationId === 'approveApplicationWithWaiver';
  let startsAt, endsAt, deposit = null;
  if (decline) {
    if (!hasOnlyKeys(body.data, ['note'])) return problem(400, 'validation_error', 'Unsupported decline fields', traceId);
  } else {
    if (!hasOnlyKeys(body.data, ['booking_id', 'summary', 'service_id', 'starts_at', 'ends_at', 'agreed_total_minor', 'currency', 'customer_email', ...(waiver ? [] : ['deposit_amount_minor'])])) {
      return problem(400, 'validation_error', 'Unsupported approval fields', traceId);
    }
    const service = serviceById(body.data.service_id);
    startsAt = new Date(body.data.starts_at);
    endsAt = new Date(body.data.ends_at);
    const total = body.data.agreed_total_minor;
    deposit = waiver ? 0 : body.data.deposit_amount_minor;
    if (!service || service.name !== row.service || body.data.currency !== 'USD'
        || !Number.isInteger(total) || total <= 0 || !Number.isInteger(deposit) || deposit < (waiver ? 0 : 1) || deposit > total
        || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt
        || endsAt - startsAt > 12 * 3600000 || startsAt <= new Date()) {
      return problem(400, 'validation_error', 'Approval requires the matching service, future interval and exact USD amounts', traceId);
    }
    if (body.data.customer_email && body.data.customer_email.toLowerCase() !== row.email.toLowerCase()) {
      return problem(409, 'ambiguous_target', 'Approval email differs from the application', traceId);
    }
    if (!calendarIsConfigured(context.env)) return problem(503, 'provider_failure', 'Calendar unavailable', traceId);
    // Submitted application events are transparent; paid bookings and private
    // holds remain blocking. Never remove the request event to check availability.
    const busy = await getBusyPeriods(context.env, startsAt.toISOString(), endsAt.toISOString());
    if (busy.some(p => startsAt < new Date(p.end) && endsAt > new Date(p.start))) {
      return problem(409, 'policy_conflict', 'The complete session conflicts with a calendar booking', traceId);
    }
  }
  if (!decisionEmailIsConfigured(context.env)) return problem(503, 'provider_failure', 'Client email unavailable', traceId);
  await writeOperation('running', null).run();
  const token = row.public_status_token || crypto.randomUUID();
  const status = decline ? 'declined' : waiver ? 'confirmed' : 'approved';
  const depositStatus = decline ? 'not_required' : waiver ? 'waived' : 'pending';
  const changed = await db.prepare(`UPDATE applications SET status = ?, deposit_status = ?,
    deposit_amount_cents = ?, deposit_currency = 'usd', agreed_total_minor = ?,
    booking_starts_at = ?, booking_ends_at = ?, public_status_token = ?, decided_at = ?, updated_at = ?,
    decision_email_status = 'not_sent', simon_version = simon_version + 1
    WHERE id = ? AND simon_version = ? AND status IN ('new', 'reviewing') AND archived_at IS NULL`)
    .bind(status, depositStatus, deposit, decline ? row.agreed_total_minor : body.data.agreed_total_minor,
      startsAt?.toISOString() || null, endsAt?.toISOString() || null, token, timestamp, timestamp, row.id, version).run();
  if (changed.meta?.changes !== 1) {
    await db.prepare("UPDATE simon_v3_operations SET status = 'failed', completed_at = ? WHERE id = ?").bind(stamp(), id).run();
    return problem(409, 'version_conflict', 'Application changed before the decision was saved', traceId);
  }
  steps.push({ name: 'website_application_decision', status: 'succeeded', provider_confirmed: true,
    provider_receipt_ref: row.id, retry_safe: true, error: null });
  let eventId = row.google_event_id;
  try {
    if (decline) {
      if (eventId) await deleteCalendarEvent(context.env, eventId);
      eventId = null;
    } else {
      const event = {
        summary: `${waiver ? 'BOOKED' : 'DEPOSIT PENDING'} · ${row.service} · ${row.artist_name || `${row.first_name} ${row.last_name}`}`,
        start: { dateTime: startsAt.toISOString(), timeZone: 'America/Chicago' },
        end: { dateTime: endsAt.toISOString(), timeZone: 'America/Chicago' },
        transparency: 'opaque', colorId: waiver ? (context.env.BOOKING_CALENDAR_COLOR_ID || '10') : (context.env.DEPOSIT_PENDING_CALENDAR_COLOR_ID || '5'),
      };
      const result = eventId ? await updateCalendarEvent(context.env, eventId, event)
        : await createCalendarEvent(context.env, { ...event, id: `simon${row.id.replaceAll('-', '')}` });
      if (!result?.id || result.status === 'cancelled') throw new Error('calendar_receipt_missing');
      eventId = result.id;
    }
    await db.prepare("UPDATE applications SET google_event_id = ?, calendar_sync_status = ?, calendar_sync_error = NULL WHERE id = ?")
      .bind(eventId, decline ? 'deleted' : 'sent', row.id).run();
    steps.push({ name: 'calendar_decision', status: 'succeeded', provider_confirmed: true,
      provider_receipt_ref: eventId || row.id, retry_safe: true, error: null });
    const url = `${context.env.PUBLIC_SITE_URL || new URL(context.request.url).origin}/application-status?token=${encodeURIComponent(token)}`;
    const message = await sendDecisionEmail(context.env, row, decline ? 'declined' : 'approved', url, { depositWaived: waiver });
    if (!message?.id) throw new Error('email_receipt_missing');
    await db.prepare("UPDATE applications SET decision_email_status = 'sent', decision_email_message_id = ?, decision_email_error = NULL WHERE id = ?")
      .bind(message.id, row.id).run();
    steps.push({ name: 'client_decision_email', status: 'succeeded', provider_confirmed: true,
      provider_receipt_ref: message.id, retry_safe: false, error: null });
  } catch {
    if (!steps.some(step => step.name === 'calendar_decision')) {
      await db.prepare("UPDATE applications SET calendar_sync_status = 'failed', calendar_sync_error = 'Decision calendar update requires reconciliation' WHERE id = ?").bind(row.id).run();
    } else {
      await db.prepare("UPDATE applications SET decision_email_status = 'failed', decision_email_error = 'Delivery not confirmed; reconcile before retry' WHERE id = ?").bind(row.id).run();
    }
    steps.push({ name: 'decision_followup', status: 'failed', provider_confirmed: false,
      provider_receipt_ref: null, retry_safe: false, error: { code: 'provider_failure' } });
  }
  const failed = steps.some(step => step.status === 'failed');
  await db.prepare('UPDATE simon_v3_operations SET status = ?, steps_json = ?, after_json = ?, completed_at = ? WHERE id = ?')
    .bind(failed ? 'partially_failed' : 'succeeded', JSON.stringify(steps), JSON.stringify({ status, deposit_status: depositStatus, application_id: row.id, booking_id: row.id, agreed_total_minor: body.data.agreed_total_minor || null }), stamp(), id).run();
  return response();
}
