import { json } from "../../_lib/admin-auth.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";
import { matchingServices } from "../../_lib/service-catalog.js";

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const query = new URL(context.request.url).searchParams.get("query") || "";
  if (!query.trim()) return json({ error: "A service query is required." }, 400);
  return json({
    services: matchingServices(query).map(({ aliases, category, ...service }) => service),
  });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
