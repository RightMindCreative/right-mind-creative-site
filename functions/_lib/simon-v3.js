import { SERVICES } from "./service-catalog.js";

export const SIMON_V3_BASE = "/api/simon/v3";
export const SIMON_V3_ROLES = Object.freeze(["admin", "employee", "client", "system"]);

const ALL = SIMON_V3_ROLES;
const STAFF = ["admin", "system"];
const CLIENT = ["admin", "system", "client"];
const EMPLOYEE = ["admin", "system", "employee"];

const route = (method, pattern, operationId, kind, options = {}) => ({
  method, pattern, operationId, kind, mode: method === "GET" ? "read" : "mutation",
  roles: STAFF, ...options,
});

export const SIMON_V3_ROUTES = Object.freeze([
  route("GET", "/catalog", "getCatalog", "catalog", { roles: ALL, special: "catalog" }),
  route("GET", "/policies", "getPolicies", "policies", { roles: ALL, special: "policies" }),
  route("GET", "/clients/search", "searchClients", "client", { roles: STAFF, special: "search" }),
  route("GET", "/clients", "listClients", "client"),
  route("POST", "/clients", "createClient", "client", { roles: CLIENT, create: true }),
  route("GET", "/clients/:client_id", "getClient", "client", { roles: CLIENT, ownerScoped: true }),
  route("PATCH", "/clients/:client_id", "updateClient", "client", { roles: CLIENT, ownerScoped: true, ifMatch: true }),
  route("POST", "/clients/:client_id/archive", "archiveClient", "client"),
  route("POST", "/clients/:client_id/restore", "restoreClient", "client"),
  route("POST", "/clients/merge", "mergeClients", "client", { provider: "website" }),
  route("GET", "/employees", "listEmployees", "employee"),
  route("POST", "/employees", "createEmployee", "employee", { create: true }),
  route("GET", "/employees/:employee_id", "getEmployee", "employee", { roles: EMPLOYEE, ownerScoped: true }),
  route("PATCH", "/employees/:employee_id", "updateEmployee", "employee", { ifMatch: true }),
  route("POST", "/employees/:employee_id/deactivate", "deactivateEmployee", "employee"),
  route("POST", "/employees/:employee_id/restore", "restoreEmployee", "employee"),
  route("GET", "/applications", "listApplications", "application", { roles: CLIENT, ownerScoped: true }),
  route("POST", "/applications", "createApplicationDraft", "application", { roles: CLIENT, ownerScoped: true, create: true }),
  route("GET", "/applications/:application_id", "getApplication", "application", { roles: CLIENT, ownerScoped: true }),
  route("PATCH", "/applications/:application_id", "updateApplication", "application", { roles: CLIENT, ownerScoped: true, ifMatch: true }),
  route("POST", "/applications/:application_id/submit", "submitApplication", "application", { roles: CLIENT, ownerScoped: true, provider: "notifications" }),
  route("POST", "/applications/:application_id/approve-with-deposit", "approveApplicationWithDeposit", "application", { provider: "stripe" }),
  route("POST", "/applications/:application_id/approve-with-waiver", "approveApplicationWithWaiver", "application", { provider: "notifications" }),
  route("POST", "/applications/:application_id/decline", "declineApplication", "application", { provider: "notifications" }),
  route("GET", "/bookings", "listBookings", "booking", { roles: CLIENT, ownerScoped: true }),
  route("POST", "/bookings", "createBooking", "booking", { roles: CLIENT, ownerScoped: true, create: true, provider: "calendar" }),
  route("GET", "/bookings/:booking_id", "getBooking", "booking", { roles: CLIENT, ownerScoped: true }),
  route("PATCH", "/bookings/:booking_id", "updateBooking", "booking", { ifMatch: true, provider: "calendar" }),
  route("POST", "/bookings/:booking_id/reschedule", "rescheduleBooking", "booking", { ifMatch: true, provider: "calendar" }),
  route("POST", "/bookings/:booking_id/split", "splitBooking", "booking", { ifMatch: true, provider: "calendar" }),
  route("POST", "/bookings/:booking_id/cancel", "cancelBooking", "booking", { ifMatch: true, provider: "calendar" }),
  route("POST", "/bookings/:booking_id/restore", "restoreBooking", "booking", { provider: "calendar" }),
  route("POST", "/calendar/availability", "checkAvailability", "availability", { roles: ALL, mode: "query", trace: true, provider: "calendar" }),
  route("GET", "/calendar/agenda", "getAgenda", "agenda", { trace: true, provider: "calendar" }),
  route("GET", "/calendar/holds", "listCalendarHolds", "calendar_hold"),
  route("POST", "/calendar/holds", "createCalendarHold", "calendar_hold", { create: true, provider: "calendar" }),
  route("GET", "/calendar/holds/:hold_id", "getCalendarHold", "calendar_hold"),
  route("PATCH", "/calendar/holds/:hold_id", "updateCalendarHold", "calendar_hold", { ifMatch: true, provider: "calendar" }),
  route("POST", "/calendar/holds/:hold_id/cancel", "cancelCalendarHold", "calendar_hold", { provider: "calendar" }),
  route("GET", "/payments/ledgers/:booking_id", "getPaymentLedger", "payment_ledger", { roles: CLIENT, ownerScoped: true, trace: true }),
  route("GET", "/payments/links", "findPaymentLinks", "payment_link", { roles: CLIENT, ownerScoped: true }),
  route("POST", "/payments/links", "createPaymentLink", "payment_link", { roles: CLIENT, ownerScoped: true, create: true, provider: "stripe" }),
  route("POST", "/payments/ledger-entries", "addLedgerEntry", "ledger_entry", { create: true, provider: "stripe" }),
  route("POST", "/payments/refunds", "createRefund", "refund", { create: true, provider: "stripe" }),
  route("POST", "/payments/reconcile", "reconcilePayment", "payment_ledger", { provider: "stripe" }),
  route("GET", "/assignments", "listAssignments", "assignment", { roles: EMPLOYEE, ownerScoped: true }),
  route("POST", "/assignments", "createAssignment", "assignment", { create: true, provider: "notifications" }),
  route("GET", "/assignments/:assignment_id", "getAssignment", "assignment", { roles: EMPLOYEE, ownerScoped: true }),
  route("POST", "/assignments/:assignment_id/respond", "respondToAssignment", "assignment", { roles: EMPLOYEE, ownerScoped: true, provider: "notifications" }),
  route("POST", "/assignments/:assignment_id/cancel", "cancelAssignment", "assignment", { provider: "notifications" }),
  route("GET", "/assignments/:assignment_id/reminders", "getAssignmentReminderState", "assignment_reminder", { roles: EMPLOYEE, ownerScoped: true }),
  route("GET", "/views/clients/:client_id", "getClientScopedView", "client_view", { roles: CLIENT, ownerScoped: true, trace: true }),
  route("GET", "/views/employees/:employee_id/sessions/:booking_id", "getEmployeeSessionView", "employee_session_view", { roles: EMPLOYEE, ownerScoped: true, trace: true }),
  route("POST", "/files/intakes", "createFileIntake", "file", { roles: ALL, ownerScoped: true, create: true, provider: "r2" }),
  route("GET", "/files/:file_id", "getFileMetadata", "file", { roles: ALL, ownerScoped: true, trace: true }),
  route("POST", "/notifications", "enqueueNotification", "notification", { create: true, provider: "notifications" }),
  route("GET", "/notifications/:notification_id", "getNotification", "notification"),
  route("GET", "/events", "listEvents", "event", { special: "events" }),
  route("GET", "/operations/:operation_id", "getOperation", "operation", { special: "operation" }),
  route("POST", "/operations/:operation_id/rollback", "rollbackOperation", "operation", { special: "rollback" }),
  route("GET", "/health", "getDependencyHealth", "dependency_health", { special: "health" }),
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value) => UUID.test(String(value || ""));

export const matchSimonV3Route = (method, pathname) => {
  const path = pathname.startsWith(SIMON_V3_BASE) ? pathname.slice(SIMON_V3_BASE.length) || "/" : pathname;
  for (const candidate of SIMON_V3_ROUTES) {
    if (candidate.method !== method) continue;
    const names = [];
    const expression = candidate.pattern.replace(/:([a-z_]+)/g, (_, name) => {
      names.push(name);
      return "([^/]+)";
    });
    const match = path.match(new RegExp(`^${expression}/?$`));
    if (!match) continue;
    const params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
    return { ...candidate, params };
  }
  return null;
};

export const problem = (status, code, title, traceId, detail = "", extra = {}) => new Response(
  JSON.stringify({
    type: `/problems/${code}`, title, status, code, retry_safe: status >= 500,
    trace_id: isUuid(traceId) ? traceId : "00000000-0000-4000-8000-000000000000",
    ...(detail ? { detail } : {}), ...extra,
  }),
  { status, headers: { "content-type": "application/problem+json; charset=utf-8", "cache-control": "no-store" } },
);

export const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

const same = (left, right) => {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
};

export const authenticateSimonV3 = (request, env) => {
  const traceId = request.headers.get("x-simon-trace-id") || "";
  if (!env.APPLICATIONS_DB || !env.SIMON_V3_SERVICE_TOKEN) {
    return { error: problem(503, "provider_failure", "Simon V3 staging is not configured", traceId) };
  }
  const bearer = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!same(bearer, env.SIMON_V3_SERVICE_TOKEN)) {
    return { error: problem(401, "unauthorized", "Service authentication required", traceId) };
  }
  const actor = {
    person_id: request.headers.get("x-simon-person-id") || "",
    role: request.headers.get("x-simon-role") || "",
    authority_grant_id: request.headers.get("x-simon-authority-grant-id") || "",
  };
  if (!isUuid(actor.person_id) || !SIMON_V3_ROLES.includes(actor.role) || !isUuid(actor.authority_grant_id)) {
    return { error: problem(401, "unauthorized", "Valid Simon actor headers are required", traceId) };
  }
  return { actor, traceId };
};

export const actorMatches = (headerActor, bodyActor) => Boolean(bodyActor)
  && headerActor.person_id === bodyActor.person_id
  && headerActor.role === bodyActor.role
  && headerActor.authority_grant_id === bodyActor.authority_grant_id;

export const hasOnlyKeys = (value, allowed) => Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.includes(key));

export const parseVersion = (value) => {
  const match = String(value || "").match(/^(?:W\/)?"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
};

export const catalog = () => ({
  version: "website-2026-10-09",
  effective_at: "2026-10-09T00:00:00.000Z",
  services: SERVICES.map(({ aliases, ...service }) => service),
});

export const policies = () => ({
  version: "website-2026-10-09",
  effective_at: "2026-10-09T00:00:00.000Z",
  timezone: "America/Chicago",
  booking_rules: {
    minimum_lead_time_hours: 48,
    weekly_hours: {
      sunday: { opens: "13:00", closes: "24:00" }, monday: null,
      tuesday: { opens: "10:00", closes: "24:00" },
      wednesday: { opens: "10:00", closes: "24:00" },
      thursday: { opens: "10:00", closes: "24:00" },
      friday: { opens: "10:00", closes: "24:00" },
      saturday: { opens: "10:00", closes: "24:00" },
    },
    uploads: { maximum_file_bytes: 26214400, maximum_total_bytes: 52428800, extensions: ["wav", "wave", "mp3", "aif", "aiff"] },
  },
  deposits: { recording: { currency: "USD", amount_minor: 7000 }, production: { currency: "USD", amount_minor: 9000 }, mixing: { currency: "USD", amount_minor: 15000 }, packages: { custom: true } },
});

export const resourceFromRow = (row) => ({
  id: row.id, kind: row.kind, version: Number(row.version), data: JSON.parse(row.data_json),
  evidence_refs: [],
});

export const operationFromRow = (row) => ({
  id: row.id, status: row.status, idempotency_key: row.idempotency_key,
  trace_id: row.trace_id, resource_refs: JSON.parse(row.resource_refs_json || "[]"),
  steps: JSON.parse(row.steps_json || "[]"), rollback: JSON.parse(row.rollback_json || '{"available":false}'),
  created_at: row.created_at, completed_at: row.completed_at || null,
});

export const hashJson = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
