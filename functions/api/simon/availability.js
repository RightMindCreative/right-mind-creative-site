import { json } from "../../_lib/admin-auth.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";
import { serviceById } from "../../_lib/service-catalog.js";
import { onRequestGet as publicAvailability } from "../availability.js";

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const url = new URL(context.request.url);
  const service = serviceById(url.searchParams.get("serviceId") || "");
  const startsAt = new Date(url.searchParams.get("startsAfter") || "");
  const durationMinutes = Number(url.searchParams.get("durationMinutes"));
  if (!service || !Number.isInteger(durationMinutes) || !service.durationOptions.includes(durationMinutes)
      || Number.isNaN(startsAt.getTime())) {
    return json({ error: "Enter a valid service, start, and duration." }, 400);
  }
  if (startsAt.getMinutes() !== 0 || startsAt.getSeconds() !== 0) {
    return json({ error: "Session start times must be on the hour." }, 422);
  }

  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(startsAt).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const publicUrl = new URL("/api/availability", context.request.url);
  publicUrl.searchParams.set("date", date);
  publicUrl.searchParams.set("duration", String(durationMinutes / 60));
  const response = await publicAvailability({
    ...context,
    request: new Request(publicUrl, { method: "GET" }),
  });
  const payload = await response.json();
  if (!response.ok) return json(payload, response.status);

  const requestedHour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23",
  }).format(startsAt));
  const available = (payload.slots || []).includes(requestedHour);
  return json({
    slots: available ? [{
      startsAt: url.searchParams.get("startsAfter"),
      endsAt: new Date(startsAt.getTime() + durationMinutes * 60000).toISOString(),
      serviceId: service.id,
      resourceId: "right-mind-studio",
    }] : [],
    reason: available ? "" : (payload.reason || "unavailable"),
  });
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
