import { json } from "../../../../_lib/admin-auth.js";
import {
  applicationMatchesIdentity,
  cancelClientApplication,
} from "../../../../_lib/client-applications.js";
import { requireSimonService } from "../../../../_lib/simon-service-auth.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function onRequestPost(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  if (!UUID_PATTERN.test(String(context.request.headers.get("Idempotency-Key") || ""))) {
    return json({ error: "A valid request identifier is required." }, 400);
  }
  let payload;
  try { payload = await context.request.json(); } catch { return json({ error: "The cancellation could not be read." }, 400); }
  const application = await context.env.APPLICATIONS_DB.prepare(
    "SELECT * FROM applications WHERE id = ?",
  ).bind(context.params.id).first();
  if (!application || !applicationMatchesIdentity(application, {
    email: payload.expectedEmail, phone: payload.expectedPhone,
  })) return json({ error: "Application not found." }, 404);
  try {
    return json(await cancelClientApplication(context, application));
  } catch (response) {
    if (response instanceof Response) return response;
    throw response;
  }
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
