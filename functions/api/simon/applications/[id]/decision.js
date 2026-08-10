import { json } from "../../../../_lib/admin-auth.js";
import {
  CONFIRMED_BOOKING_COLOR_ID,
} from "../../../../_lib/application-notifications.js";
import {
  decisionEmailIsConfigured, sendDecisionEmail,
} from "../../../../_lib/decision-email.js";
import { updateCalendarEvent } from "../../../../_lib/google-calendar.js";
import { requireSimonService } from "../../../../_lib/simon-service-auth.js";
import { notifySimonOfDecision } from "../../../../_lib/simon-notifications.js";

const clean = (value, length = 200) => String(value || "").trim().slice(0, length);
export const SIMON_WAIVE_DECISION = Object.freeze({
  decision: "approved", waiveDeposit: true, resultingStatus: "confirmed",
  depositStatus: "waived",
});

export async function onRequestPost(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const idempotencyKey = clean(context.request.headers.get("idempotency-key"));
  if (!idempotencyKey) return json({ error: "An Idempotency-Key header is required." }, 400);
  let payload;
  try { payload = await context.request.json(); }
  catch { return json({ error: "The approval request could not be read." }, 400); }
  if (payload.decision !== SIMON_WAIVE_DECISION.decision
      || payload.waiveDeposit !== SIMON_WAIVE_DECISION.waiveDeposit) {
    return json({ error: "Simon may only approve with an explicit deposit waiver." }, 422);
  }
  const application = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE id = ?",
  ).bind(context.params.id).first();
  if (!application) return json({ error: "Application not found." }, 404);
  if (application.status === "confirmed" && application.deposit_status === "waived") {
    return json({
      application: {
        id: application.id,
        applicantName: `${application.first_name || ""} ${application.last_name || ""}`.trim(),
        artistName: application.artist_name || "",
        status: "confirmed",
        depositStatus: "waived",
      },
      duplicate: true,
      notificationStatus: application.decision_email_status,
    });
  }
  if (!["new", "reviewing", "approved", "payment_pending"].includes(application.status)) {
    return json({ error: `This application is already ${application.status}.` }, 409);
  }
  if (!decisionEmailIsConfigured(context.env)) {
    return json({ error: "Decision email delivery is not configured yet." }, 503);
  }

  const decidedAt = new Date().toISOString();
  const statusToken = application.public_status_token || crypto.randomUUID();
  const statusUrl = `${new URL(context.request.url).origin}/application-status?token=${encodeURIComponent(statusToken)}`;
  await context.env.APPLICATIONS_DB.prepare(`
    UPDATE applications
    SET status = 'confirmed', updated_at = ?, decided_at = ?, public_status_token = ?,
        decision_email_status = 'sending', decision_email_error = NULL,
        deposit_amount_cents = 0, deposit_currency = 'usd', deposit_status = 'waived'
    WHERE id = ?
  `).bind(decidedAt, decidedAt, statusToken, application.id).run();

  if (application.google_event_id) {
    try {
      const artist = application.artist_name
        || `${application.first_name || ""} ${application.last_name || ""}`.trim();
      await updateCalendarEvent(context.env, application.google_event_id, {
        summary: `CONFIRMED · ${application.service} · ${artist}`,
        colorId: context.env.CONFIRMED_CALENDAR_COLOR_ID || CONFIRMED_BOOKING_COLOR_ID,
        eventLabelName: "Basil",
        transparency: "opaque",
      });
      await context.env.APPLICATIONS_DB.prepare(`
        UPDATE applications SET calendar_sync_status = 'sent', calendar_sync_error = NULL,
          updated_at = ? WHERE id = ?
      `).bind(new Date().toISOString(), application.id).run();
    } catch (error) {
      await context.env.APPLICATIONS_DB.prepare(`
        UPDATE applications SET calendar_sync_status = 'failed', calendar_sync_error = ?,
          updated_at = ? WHERE id = ?
      `).bind(String(error.message || error).slice(0, 500), new Date().toISOString(), application.id).run();
    }
  }

  let notificationStatus = "sent";
  try {
    const sent = await sendDecisionEmail(
      context.env, application, "approved", statusUrl, { depositWaived: true },
    );
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications SET decision_email_status = 'sent', decision_email_message_id = ?,
        updated_at = ? WHERE id = ?
    `).bind(sent.id || null, new Date().toISOString(), application.id).run();
    context.waitUntil(notifySimonOfDecision({
      ...application, public_status_token: statusToken,
    }, "approved", context.env));
  } catch (error) {
    notificationStatus = "failed";
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications SET decision_email_status = 'failed', decision_email_error = ?,
        updated_at = ? WHERE id = ?
    `).bind(String(error.message || error).slice(0, 1000), new Date().toISOString(), application.id).run();
  }
  const response = {
    application: {
      id: application.id,
      applicantName: `${application.first_name || ""} ${application.last_name || ""}`.trim(),
      artistName: application.artist_name || "",
      status: "confirmed",
      depositStatus: "waived",
    },
    statusUrl,
    notificationStatus,
  };
  try {
    await context.env.APPLICATIONS_DB.batch([
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO simon_idempotency
          (idempotency_key, request_hash, application_id, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(idempotencyKey, `application.approve-waive:${application.id}`, application.id,
        JSON.stringify(response), new Date().toISOString()),
      context.env.APPLICATIONS_DB.prepare(`
        INSERT INTO simon_api_audit
          (id, created_at, action, request_id, idempotency_key, application_id, outcome)
        VALUES (?, ?, 'application.approve-waive', ?, ?, ?, 'confirmed')
      `).bind(crypto.randomUUID(), new Date().toISOString(),
        context.request.headers.get("x-request-id") || "", idempotencyKey, application.id),
    ]);
  } catch (error) {
    console.error("Simon application approval audit failed", { applicationId: application.id, error });
  }
  return json(response);
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
