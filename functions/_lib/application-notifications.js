import { calendarIsConfigured, createCalendarEvent } from "./google-calendar.js";

const REQUEST_COLOR_ID = "6";
const DEFAULT_TIME_ZONE = "America/Chicago";

const escapeHtml = (value) => String(value || "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const addHours = (date, time, hours) => {
  const start = new Date(`${date}T${time}:00`);
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
    const start = `${application.preferredDate}T${application.preferredTime}:00`;
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
    transparency: "transparent",
    ...eventDates(application, application.createdAt, env.BOOKING_TIME_ZONE || DEFAULT_TIME_ZONE),
  };
};

export const addApplicationToCalendar = async (application, files, env) => {
  if (!calendarIsConfigured(env)) return { status: "not_configured" };
  const event = await createCalendarEvent(env, buildApplicationEvent(application, files, env));
  return { status: "sent", eventId: event.id, eventLink: event.htmlLink };
};

export const sendApplicationEmail = async (application, files, env) => {
  if (!env.APPLICATION_EMAIL) return { status: "not_configured" };
  const to = env.APPLICATION_NOTIFICATION_EMAIL;
  const from = env.APPLICATION_NOTIFICATION_FROM;
  if (!to || !from) return { status: "not_configured" };

  const artist = application.artistName || `${application.firstName} ${application.lastName}`.trim();
  const rows = fieldRows(application, files);
  const html = `
    <h1>New session request</h1>
    <p><strong>${escapeHtml(application.service)}</strong> from ${escapeHtml(artist)}</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      ${rows.map(([label, value]) => `
        <tr>
          <td style="vertical-align:top;color:#666"><strong>${escapeHtml(label)}</strong></td>
          <td style="white-space:pre-wrap">${escapeHtml(value)}</td>
        </tr>
      `).join("")}
    </table>
  `;

  await env.APPLICATION_EMAIL.send({
    to,
    from,
    replyTo: application.email,
    subject: `New session request: ${application.service} · ${artist}`,
    text: `A new session request was submitted.\n\n${plainDescription(application, files)}`,
    html,
  });
  return { status: "sent" };
};
