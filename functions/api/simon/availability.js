import { json } from "../../_lib/admin-auth.js";
import { requireSimonService } from "../../_lib/simon-service-auth.js";
import { serviceById } from "../../_lib/service-catalog.js";
import { onRequestGet as publicAvailability } from "../availability.js";
import { calendarIsConfigured, getBusyPeriods } from "../../_lib/google-calendar.js";

const centralParts = (date) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).formatToParts(date).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});

const customDurationIsValid = (minutes) => (
  Number.isInteger(minutes) && minutes >= 30 && minutes <= 720 && minutes % 30 === 0
);

const customAvailability = async (context, service, startsAt, endsAt, durationMinutes) => {
  if (!calendarIsConfigured(context.env)) {
    return json({ error: "Live calendar availability is not configured." }, 503);
  }
  if (startsAt.getMinutes() % 30 !== 0 || startsAt.getSeconds() !== 0) {
    return json({ error: "Custom sessions must start on a half-hour boundary." }, 422);
  }
  const start = centralParts(startsAt);
  const end = centralParts(endsAt);
  const startDate = `${start.year}-${start.month}-${start.day}`;
  const endDate = `${end.year}-${end.month}-${end.day}`;
  const startMinutes = Number(start.hour) * 60 + Number(start.minute);
  const endMinutes = Number(end.hour) * 60 + Number(end.minute);
  const openingMinutes = start.weekday === "Sun" ? 13 * 60 : 10 * 60;
  if (start.weekday === "Mon" || startDate !== endDate
      || startMinutes < openingMinutes || endMinutes <= startMinutes || endMinutes > 24 * 60) {
    return json({ slots: [], reason: "outside-hours" });
  }
  try {
    const busy = await getBusyPeriods(context.env, startsAt.toISOString(), endsAt.toISOString());
    const overlaps = busy.some((period) => (
      startsAt < new Date(period.end) && endsAt > new Date(period.start)
    ));
    return json({
      slots: overlaps ? [] : [{
        startsAt: context.request.url && new URL(context.request.url).searchParams.get("startsAfter"),
        endsAt: endsAt.toISOString(), serviceId: service.id, resourceId: "right-mind-studio",
      }],
      reason: overlaps ? "unavailable" : "",
      customDurationOverride: true,
    });
  } catch (error) {
    console.error("Simon custom availability lookup failed", error);
    return json({ error: "Live availability is temporarily unavailable." }, 503);
  }
};

export async function onRequestGet(context) {
  const unauthorized = requireSimonService(context);
  if (unauthorized) return unauthorized;
  const url = new URL(context.request.url);
  const service = serviceById(url.searchParams.get("serviceId") || "");
  const startsAt = new Date(url.searchParams.get("startsAfter") || "");
  const endsAt = new Date(url.searchParams.get("endsBefore") || "");
  const durationMinutes = Number(url.searchParams.get("durationMinutes"));
  const allowCustomDuration = url.searchParams.get("allowCustomDuration") === "true";
  const validDuration = service?.durationOptions.includes(durationMinutes)
    || (allowCustomDuration && customDurationIsValid(durationMinutes));
  if (!service || !validDuration
      || Number.isNaN(startsAt.getTime())) {
    return json({ error: "Enter a valid service, start, and duration." }, 400);
  }
  if (allowCustomDuration && !service.durationOptions.includes(durationMinutes)) {
    if (Number.isNaN(endsAt.getTime())
        || endsAt.getTime() - startsAt.getTime() !== durationMinutes * 60000) {
      return json({ error: "The custom session end does not match its duration." }, 422);
    }
    return customAvailability(context, service, startsAt, endsAt, durationMinutes);
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
