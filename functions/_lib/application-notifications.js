import {
  calendarIsConfigured,
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
} from "./google-calendar.js";

const REQUEST_COLOR_ID = "6";
export const DEPOSIT_PENDING_COLOR_ID = "5";
export const CONFIRMED_BOOKING_COLOR_ID = "10";
const DEFAULT_TIME_ZONE = "America/Chicago";

const normalizeTime = (value) => {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) throw new Error("The requested session time is invalid.");
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) throw new Error("The requested session time is invalid.");
    hour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) throw new Error("The requested session time is invalid.");
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const addHours = (date, time, hours) => {
  const start = new Date(`${date}T${normalizeTime(time)}:00`);
  start.setHours(start.getHours() + hours);
  const pad = (value) => String(value).padStart(2, "0");
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}:00`;
};

const nextDate = (date) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

const durationHours = (serviceOption) => {
  const match = String(serviceOption || "").match(/^(\d+)\s*hours?$/i);
  if (match) return Number(match[1]);
  if (/day rate|full day/i.test(serviceOption || "")) return 12;
  return 1;
};

const fieldRows = (application, files) => [
  ["Application ID", application.id],
  ["Status", "New session request"],
  ["Service category", application.category],
  ["Service", application.service],
  ["Service option", application.serviceOption],
  ["Preferred date", application.preferredDate],
  ["Preferred time", application.preferredTime],
  ["Name", `${application.firstName} ${application.lastName}`.trim()],
  ["Artist name", application.artistName],
  ["Email", application.email],
  ["Phone", application.phone],
  ["Number of stems/trackouts", application.stemCount],
  ["Social links", application.socialLinks],
  ["Additional information", application.notes],
  ["Uploaded files", files.map((file) => file.name).join(", ")],
].filter(([, value]) => value !== null && value !== undefined && String(value).trim());

const plainDescription = (application, files) => fieldRows(application, files)
  .map(([label, value]) => `${label}: ${value}`)
  .join("\n\n");

const eventDates = (application, createdAt, timeZone) => {
  if (application.usesCalendar) {
    const start = `${application.preferredDate}T${normalizeTime(application.preferredTime)}:00`;
    return {
      start: { dateTime: start, timeZone },
      end: {
        dateTime: addHours(
          application.preferredDate,
          application.preferredTime,
          durationHours(application.serviceOption),
        ),
        timeZone,
      },
    };
  }

  const date = createdAt.slice(0, 10);
  return {
    start: { date },
    end: { date: nextDate(date) },
  };
};

export const buildApplicationEvent = (application, files, env) => {
  const artist = application.artistName || `${application.firstName} ${application.lastName}`.trim();
  return {
    summary: `SESSION REQUEST · ${application.service} · ${artist}`,
    description: plainDescription(application, files),
    colorId: env.APPLICATION_CALENDAR_COLOR_ID || REQUEST_COLOR_ID,
    eventLabelName: "Tangerine",
    transparency: "transparent",
    ...eventDates(application, application.createdAt, env.BOOKING_TIME_ZONE || DEFAULT_TIME_ZONE),
  };
};

export const addApplicationToCalendar = async (application, files, env) => {
  if (application.usesCalendar === false) return { status: "not_required" };
  if (!calendarIsConfigured(env)) return { status: "not_configured" };
  const event = await createCalendarEvent(env, buildApplicationEvent(application, files, env));
  return { status: "sent", eventId: event.id, eventLink: event.htmlLink };
};

export const calendarApplicationFromRow = (row) => ({
  id: row.id,
  createdAt: row.created_at,
  category: row.category,
  service: row.service,
  serviceOption: row.service_option,
  preferredDate: row.preferred_date,
  preferredTime: row.preferred_time,
  firstName: row.first_name,
  lastName: row.last_name,
  artistName: row.artist_name,
  email: row.email,
  phone: row.phone,
  stemCount: row.stem_count,
  socialLinks: row.social_links,
  notes: row.notes,
  usesCalendar: row.category !== "mixing" && row.service !== "Custom Project",
});

export const reconcileApplicationCalendar = async (row, files, env) => {
  const application = calendarApplicationFromRow(row);
  if (!application.usesCalendar) return { status: "not_required", eventId: null };

  if (row.status === "declined") {
    if (row.google_event_id) await deleteCalendarEvent(env, row.google_event_id);
    return { status: "deleted", eventId: null };
  }

  let eventId = row.google_event_id;
  let result = { status: "sent", eventId };
  if (!eventId) {
    result = await addApplicationToCalendar(application, files, env);
    eventId = result.eventId;
  }

  if (eventId && ["approved", "payment_pending", "confirmed"].includes(row.status)) {
    const artist = row.artist_name || `${row.first_name} ${row.last_name}`.trim();
    const confirmed = row.status === "confirmed" || row.deposit_status === "paid";
    await updateCalendarEvent(env, eventId, {
      summary: `${confirmed ? "BOOKED" : "DEPOSIT PENDING"} · ${row.service} · ${artist}`,
      colorId: confirmed
        ? (env.BOOKING_CALENDAR_COLOR_ID || CONFIRMED_BOOKING_COLOR_ID)
        : (env.DEPOSIT_PENDING_CALENDAR_COLOR_ID || DEPOSIT_PENDING_COLOR_ID),
      eventLabelName: confirmed ? "Basil" : "Citron",
      transparency: confirmed ? "opaque" : "transparent",
    });
  }

  return { ...result, eventId };
};
