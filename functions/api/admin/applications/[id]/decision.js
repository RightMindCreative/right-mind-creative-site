import { json, requireAdmin } from "../../../../_lib/admin-auth.js";
import { decisionEmailIsConfigured, sendDecisionEmail } from "../../../../_lib/decision-email.js";
import { depositForApplication } from "../../../../_lib/deposits.js";

const validDecisions = new Set(["approved", "declined"]);

export async function onRequestPost(context) {
  const unauthorized = await requireAdmin(context);
  if (unauthorized) return unauthorized;
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: "The decision could not be read." }, 400);
  }
  const decision = String(payload.decision || "").toLowerCase();
  if (!validDecisions.has(decision)) return json({ error: "Choose approve or decline." }, 422);

  const application = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE id = ?",
  ).bind(context.params.id).first();
  if (!application) return json({ error: "Application not found." }, 404);
  if (application.status === decision && application.decision_email_status === "sent") {
    return json({ application, duplicate: true });
  }
  if (["approved", "declined"].includes(application.status) && application.status !== decision) {
    return json({ error: `This application has already been ${application.status}.` }, 409);
  }
  if (!decisionEmailIsConfigured(context.env)) {
    return json({ error: "Decision email delivery is not configured yet." }, 503);
  }

  const decidedAt = new Date().toISOString();
  let depositAmount = null;
  if (decision === "approved") {
    try {
      depositAmount = depositForApplication(application, payload.customDeposit);
    } catch (error) {
      return json({ error: error.message }, 422);
    }
  }
  const statusToken = application.public_status_token || crypto.randomUUID();
  const statusUrl = `${new URL(context.request.url).origin}/application-status?token=${encodeURIComponent(statusToken)}`;
  await context.env.APPLICATIONS_DB.prepare(`
    UPDATE applications
    SET status = ?, updated_at = ?, decided_at = ?, public_status_token = ?,
        decision_email_status = 'sending', decision_email_error = NULL,
        deposit_amount_cents = ?, deposit_currency = 'usd',
        deposit_status = ?
    WHERE id = ?
  `).bind(
    decision, decidedAt, decidedAt, statusToken, depositAmount,
    decision === "approved" ? "pending" : "not_required", application.id,
  ).run();

  try {
    const message = await sendDecisionEmail(context.env, application, decision, statusUrl);
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications
      SET decision_email_status = 'sent', decision_email_message_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(message.id || null, new Date().toISOString(), application.id).run();
    return json({
      application: {
        ...application, status: decision, decided_at: decidedAt,
        public_status_token: statusToken, decision_email_status: "sent",
        deposit_amount_cents: depositAmount,
        deposit_status: decision === "approved" ? "pending" : "not_required",
      },
      statusUrl,
    });
  } catch (error) {
    await context.env.APPLICATIONS_DB.prepare(`
      UPDATE applications
      SET decision_email_status = 'failed', decision_email_error = ?, updated_at = ?
      WHERE id = ?
    `).bind(String(error.message || error).slice(0, 1000), new Date().toISOString(), application.id).run();
    console.error("Decision email failed", { applicationId: application.id, decision, error });
    return json({
      error: "The decision was saved, but the applicant email could not be sent.",
      decisionSaved: true,
    }, 502);
  }
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
