import { json } from "../../_lib/admin-auth.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const result = await context.env.APPLICATIONS_DB.prepare(`
    SELECT id, created_at, status, service, first_name, last_name, artist_name
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
      applicantName: `${item.first_name || ""} ${item.last_name || ""}`.trim(),
      artistName: item.artist_name || "",
    })),
  });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
