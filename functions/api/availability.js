import { calendarIsConfigured, getBusyPeriods } from "../_lib/google-calendar.js";

const TIME_ZONE = "America/Chicago";
const ALLOWED_DURATIONS = new Set([2, 3, 4, 6, 8, 12]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

const localParts = (date) => new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
}).formatToParts(date).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});

const centralOffset = (date) => {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "GMT-06:00";
  return value.replace("GMT", "");
};

const toCentralIso = (date, hour) => {
  const probe = new Date(`${date}T12:00:00Z`);
  return `${date}T${String(hour).padStart(2, "0")}:00:00${centralOffset(probe)}`;
};

const nextDate = (date) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

const overlaps = (start, end, period) => (
  new Date(start) < new Date(period.end) && new Date(end) > new Date(period.start)
);

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const date = url.searchParams.get("date") || "";
  const duration = Number(url.searchParams.get("duration"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !ALLOWED_DURATIONS.has(duration)) {
    return json({ error: "Enter a valid date and session length." }, 400);
  }

  const requested = new Date(`${date}T12:00:00Z`);
  const parts = localParts(requested);
  const normalizedDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (normalizedDate !== date) return json({ error: "Enter a valid date." }, 400);
  if (parts.weekday === "Mon") return json({ date, slots: [], reason: "closed" });

  const firstHour = parts.weekday === "Sun" ? 13 : 10;
  const latestHour = 24 - duration;
  if (firstHour > latestHour) return json({ date, slots: [], reason: "outside-hours" });

  const candidates = Array.from(
    { length: latestHour - firstHour + 1 },
    (_, index) => firstHour + index,
  );
  if (!calendarIsConfigured(context.env)) {
    return json({
      date,
      slots: candidates,
      calendarConnected: false,
    });
  }

  try {
    const dayStart = toCentralIso(date, firstHour);
    const dayEnd = toCentralIso(nextDate(date), 0);
    const busy = await getBusyPeriods(context.env, dayStart, dayEnd);
    const slots = candidates.filter((hour) => {
      const start = toCentralIso(date, hour);
      const endDate = new Date(new Date(start).getTime() + duration * 60 * 60 * 1000).toISOString();
      return !busy.some((period) => overlaps(start, endDate, period));
    });
    return json({ date, slots, calendarConnected: true });
  } catch (error) {
    console.error("Availability lookup failed", error);
    return json({ error: "Live availability is temporarily unavailable." }, 503);
  }
}

export function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: "Method not allowed." }, 405);
}
