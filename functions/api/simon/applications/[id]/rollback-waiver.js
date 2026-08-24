import { json } from "../../../../_lib/admin-auth.js";
import { REQUEST_COLOR_ID } from "../../../../_lib/application-notifications.js";
import { updateCalendarEvent } from "../../../../_lib/google-calendar.js";
import { requireSimonService } from "../../../../_lib/simon-service-auth.js";

const clean = (value, length = 200) => String(value || "").trim().slice(0, length);
const normalized = (value) => clean(value).toLocaleLowerCase().replace(/\s+/g, " ");

export async function onRequestPost(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const idempotencyKey = clean(context.request.headers.get("idempotency-key"));
  if (!idempotencyKey) return json({ error: "An Idempotency-Key header is required." }, 400);
  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: "The rollback request could not be read." }, 400); }
  if (payload.action !== "revert_erroneous_waiver" || payload.restoreStatus !== "new") {
    return json({ error: "This endpoint only restores an erroneous Simon waiver to new." }, 422);
  }
  const expectedArtistName = normalized(payload.expectedArtistName);
  if (!expectedArtistName) return json({ error: "The exact expected artist name is required." }, 422);

  const db = context.env.APPLICATIONS_DB;
  const application = await db.prepare("SELECT * FROM applications WHERE id = ?")
    .bind(context.params.id).first();
  if (!application) return json({ error: "Application not found." }, 404);
  const actualArtistName = normalized(application.artist_name
    || `${application.first_name || ""} ${application.last_name || ""}`);
  if (actualArtistName !== expectedArtistName) {
    return json({ error: "The application does not match the exact expected artist." }, 409);
  }
  if (application.status === "new" && application.deposit_status === "not_required") {
    return json({ application: {
      id: application.id, artistName: application.artist_name || "",
      status: "new", depositStatus: "not_required",
    }, duplicate: true });
  }
  if (application.status !== "confirmed" || application.deposit_status !== "waived"
      || Number(application.deposit_amount_paid_cents || 0) !== 0
      || application.stripe_payment_intent_id) {
    return json({ error: "Only an unpaid, Simon-waived application can be rolled back." }, 409);
  }
  const audit = await db.prepare(`
    SELECT action, outcome FROM simon_api_audit
    WHERE application_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(application.id).first();
  if (!audit || audit.action !== "application.approve-waive" || audit.outcome !== "confirmed") {
    return json({ error: "The latest Simon audit does not prove an erroneous waiver." }, 409);
  }

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE applications
    SET status = 'new', updated_at = ?, decided_at = NULL,
        decision_email_status = 'not_sent', decision_email_error = NULL,
        decision_email_message_id = NULL, deposit_amount_cents = NULL,
        deposit_status = 'not_required'
    WHERE id = ?
  `).bind(now, application.id).run();

  if (application.google_event_id) {
    try {
      const artist = application.artist_name
        || `${application.first_name || ""} ${application.last_name || ""}`.trim();
      await updateCalendarEvent(context.env, application.google_event_id, {
        summary: `SESSION REQUEST · ${application.service} · ${artist}`,
        colorId: context.env.APPLICATION_CALENDAR_COLOR_ID || REQUEST_COLOR_ID,
        eventLabelName: "Tangerine",
        transparency: "transparent",
      });
      await db.prepare(`
        UPDATE applications SET calendar_sync_status = 'sent', calendar_sync_error = NULL,
          updated_at = ? WHERE id = ?
      `).bind(new Date().toISOString(), application.id).run();
    } catch (error) {
      await db.prepare(`
        UPDATE applications SET calendar_sync_status = 'failed', calendar_sync_error = ?,
          updated_at = ? WHERE id = ?
      `).bind(String(error.message || error).slice(0, 500), new Date().toISOString(), application.id).run();
    }
  }

  const response = { application: {
    id: application.id, artistName: application.artist_name || "",
    status: "new", depositStatus: "not_required",
  } };
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO simon_idempotency
          (idempotency_key, request_hash, application_id, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(idempotencyKey, `application.rollback-waiver:${application.id}`,
        application.id, JSON.stringify(response), now),
      db.prepare(`
        INSERT INTO simon_api_audit
          (id, created_at, action, request_id, idempotency_key, application_id, outcome)
        VALUES (?, ?, 'application.rollback-waiver', ?, ?, ?, 'new')
      `).bind(crypto.randomUUID(), now,
        context.request.headers.get("x-request-id") || "", idempotencyKey, application.id),
    ]);
  } catch (error) {
    console.error("Simon waiver rollback audit failed", { applicationId: application.id, error });
  }
  return json(response);
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
