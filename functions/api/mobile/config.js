import { SERVICES } from "../../_lib/service-catalog.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  },
});

export const mobileBookingConfig = Object.freeze({
  apiVersion: "1.0.0",
  timeZone: "America/Chicago",
  minimumLeadTimeHours: 48,
  weeklyHours: {
    sunday: { opens: "13:00", closes: "24:00" },
    monday: null,
    tuesday: { opens: "10:00", closes: "24:00" },
    wednesday: { opens: "10:00", closes: "24:00" },
    thursday: { opens: "10:00", closes: "24:00" },
    friday: { opens: "10:00", closes: "24:00" },
    saturday: { opens: "10:00", closes: "24:00" },
  },
  uploads: {
    maximumFileBytes: 26214400,
    maximumTotalBytes: 52428800,
    primaryAudioExtensions: ["wav", "wave", "mp3", "aif", "aiff"],
  },
  applicationStatuses: [
    "new", "reviewing", "approved", "payment_pending", "confirmed", "declined", "cancelled",
  ],
  depositStatuses: ["not_required", "pending", "paid", "waived", "refunded"],
  services: SERVICES.map(({ aliases, ...service }) => service),
  endpoints: {
    availability: "/api/availability",
    submitApplication: "/api/applications",
    applicationStatus: "/api/application-status",
    depositCheckout: "/api/application-status/checkout",
    openApi: "/right-mind-booking-openapi.json",
  },
});

export function onRequest(context) {
  if (context.request.method === "GET") return json(mobileBookingConfig);
  return json({ error: "Method not allowed." }, 405);
}
