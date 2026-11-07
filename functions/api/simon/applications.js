import { json } from "../../_lib/admin-auth.js";
import {
  applicationMatchesIdentity,
  clientApplicationSummary,
  normalizedEmail,
  normalizedPhone,
} from "../../_lib/client-applications.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const url = new URL(context.request.url);
  const email = normalizedEmail(url.searchParams.get("email"));
  const phone = normalizedPhone(url.searchParams.get("phone"));
  if (email || phone) {
    const result = await context.env.APPLICATIONS_DB.prepare(`
      SELECT * FROM applications
      WHERE (? != '' AND LOWER(TRIM(email)) = ?)
        OR (? != '' AND SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), '(', ''), ')', ''), ' ', ''), -10) = ?)
      ORDER BY created_at DESC LIMIT 100
    `).bind(email, email, phone, phone).all();
    return json({
      applications: (result.results || [])
        .filter((item) => applicationMatchesIdentity(item, { email, phone }))
        .map(clientApplicationSummary),
    });
  }
  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT id, created_at, updated_at, status, category, service, service_option,
      preferred_date, preferred_time, first_name, last_name, artist_name, email, phone,
      deposit_amount_cents, deposit_currency, deposit_status, deposit_paid_at
    FROM applications
    WHERE status IN ('new', 'reviewing', 'approved', 'payment_pending')
    ORDER BY created_at DESC
    LIMIT 10
  `).all();
  return json({
    applications: (result.results || []).map((item) => ({
      id: item.id,
      createdAt: item.created_at,
      status: item.status,
      serviceName: item.service,
      serviceOption: item.service_option || "",
      preferredDate: item.preferred_date || "",
      preferredTime: item.preferred_time || "",
      applicantName: `${item.first_name || ""} ${item.last_name || ""}`.trim(),
      artistName: item.artist_name || "",
      email: item.email || "",
      phone: item.phone || "",
      depositAmountCents: item.deposit_amount_cents,
      depositStatus: item.deposit_status || "not_required",
    })),
  });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
