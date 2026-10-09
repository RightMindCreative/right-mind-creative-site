import {
  actorMatches, authenticateSimonV3, catalog, hashJson, hasOnlyKeys, isUuid, jsonResponse,
  matchSimonV3Route, operationFromRow, parseVersion, policies, problem, resourceFromRow,
} from "../../../_lib/simon-v3.js";

const clean = (value, maximum = 500) => String(value || "").trim().slice(0, maximum);
const now = () => new Date().toISOString();

const routeId = (route) => {
  for (const key of ["client_id", "employee_id", "application_id", "booking_id", "hold_id", "assignment_id", "file_id", "notification_id"]) {
    if (route.params[key]) return route.params[key];
  }
  return null;
};

const eventStatement = (db, { traceId, route, actor, resourceId = null, operationId = null, outcome, evidence = {} }) => db.prepare(`
  INSERT INTO simon_v3_events
    (id, trace_id, action, requester_person_id, requester_role, resource_kind,
      resource_id, operation_id, outcome, evidence_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).bind(
  crypto.randomUUID(), traceId, route.operationId, actor.person_id, actor.role, route.kind,
  resourceId, operationId, outcome, JSON.stringify(evidence), now(),
);

const canSee = (route, actor, row) => {
  if (!route.ownerScoped || ["admin", "system"].includes(actor.role)) return true;
  return row?.owner_person_id === actor.person_id || row?.id === actor.person_id;
};

const requireRouteAccess = (route, actor, traceId) => {
  if (!route.roles.includes(actor.role)) return problem(403, "forbidden", "This actor role cannot perform that operation", traceId);
  return null;
};

const validatePathIds = (route, traceId) => {
  for (const [name, value] of Object.entries(route.params)) {
    if (name.endsWith("_id") && !isUuid(value)) return problem(400, "validation_error", `Invalid ${name}`, traceId);
  }
  return null;
};

const readJson = async (request, traceId) => {
  try { return { value: await request.json() }; }
  catch { return { error: problem(400, "validation_error", "A valid JSON body is required", traceId) }; }
};

const loadResource = async (db, id) => db.prepare(`
  SELECT id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at
  FROM simon_v3_resources WHERE id = ?
`).bind(id).first();

const auditRead = async (context, route, actor, traceId, resourceId, outcome) => {
  await eventStatement(context.env.APPLICATIONS_DB, { traceId, route, actor, resourceId, outcome }).run();
};

const readSpecial = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  const url = new URL(context.request.url);
  if (route.special === "catalog") return jsonResponse(catalog());
  if (route.special === "policies") return jsonResponse(policies());
  if (route.special === "health") {
    const items = [
      { id: crypto.randomUUID(), kind: "dependency_health", version: 1, data: { dependency: "d1", state: "ready", environment: "staging" }, evidence_refs: [] },
      { id: crypto.randomUUID(), kind: "dependency_health", version: 1, data: { dependency: "external_providers", state: "not_verified", environment: "staging" }, evidence_refs: [] },
    ];
    await auditRead(context, route, actor, traceId, null, "succeeded");
    return jsonResponse({ items, next_cursor: null });
  }
  if (route.special === "operation") {
    const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(route.params.operation_id).first();
    if (!row) return problem(404, "not_found", "Operation not found", traceId);
    await auditRead(context, route, actor, traceId, null, "succeeded");
    return jsonResponse(operationFromRow(row));
  }
  if (route.special === "events") {
    const after = clean(url.searchParams.get("after"), 40);
    const result = after
      ? await db.prepare("SELECT * FROM simon_v3_events WHERE created_at > ? ORDER BY created_at DESC LIMIT 100").bind(after).all()
      : await db.prepare("SELECT * FROM simon_v3_events ORDER BY created_at DESC LIMIT 100").all();
    const items = (result.results || []).map((row) => ({
      id: row.id, kind: "event", version: 1,
      data: { trace_id: row.trace_id, action: row.action, requester_role: row.requester_role, resource_kind: row.resource_kind, resource_id: row.resource_id, operation_id: row.operation_id, outcome: row.outcome, evidence: JSON.parse(row.evidence_json), created_at: row.created_at },
      evidence_refs: [],
    }));
    return jsonResponse({ items, next_cursor: null });
  }
  if (route.special === "search") {
    const query = clean(url.searchParams.get("query"), 200).toLowerCase();
    if (!query) return problem(400, "validation_error", "A search query is required", traceId);
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const result = await db.prepare(`
      SELECT * FROM simon_v3_resources
      WHERE kind = 'client' AND (? = 1 OR archived = 0) AND lower(data_json) LIKE ?
      ORDER BY updated_at DESC LIMIT 25
    `).bind(includeArchived ? 1 : 0, `%${query.replace(/[\\%_]/g, "\\$&")}%`).all();
    const exact = [];
    const hints = [];
    for (const row of result.results || []) {
      const item = resourceFromRow(row);
      const values = [item.data.email, item.data.phone, item.data.name, item.data.artist_name].map((value) => clean(value, 200).toLowerCase());
      (values.includes(query) ? exact : hints).push(item);
    }
    await auditRead(context, route, actor, traceId, null, "succeeded");
    return jsonResponse({ exact_matches: exact, duplicate_hints: hints });
  }
  return null;
};

const readResource = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  if (route.provider) {
    await auditRead(context, route, actor, traceId, routeId(route), "failed");
    return problem(502, "provider_failure", `${route.provider} read has no verified staging receipt`, traceId, "No provider result was represented as successful.");
  }
  const id = routeId(route);
  if (id) {
    const row = await loadResource(db, id);
    if (!row || row.kind !== route.kind || Number(row.archived)) return problem(404, "not_found", "Resource not found", traceId);
    if (!canSee(route, actor, row)) return problem(403, "forbidden", "The resource is outside this actor's scope", traceId);
    await auditRead(context, route, actor, traceId, id, "succeeded");
    return jsonResponse(resourceFromRow(row), 200, { etag: `"${row.version}"` });
  }
  const state = clean(new URL(context.request.url).searchParams.get("state"), 100);
  const ownerClause = route.ownerScoped && !["admin", "system"].includes(actor.role) ? " AND owner_person_id = ?" : "";
  const stateClause = state ? " AND state = ?" : "";
  const bindings = [route.kind];
  if (ownerClause) bindings.push(actor.person_id);
  if (stateClause) bindings.push(state);
  const result = await db.prepare(`
    SELECT * FROM simon_v3_resources WHERE kind = ? AND archived = 0${ownerClause}${stateClause}
    ORDER BY updated_at DESC LIMIT 100
  `).bind(...bindings).all();
  await auditRead(context, route, actor, traceId, null, "succeeded");
  return jsonResponse({ items: (result.results || []).map(resourceFromRow), next_cursor: null });
};

const stateFor = (operationId, data, current) => ({
  archiveClient: "archived", restoreClient: "active", deactivateEmployee: "inactive",
  restoreEmployee: "active", createApplicationDraft: "draft", submitApplication: "submitted",
  declineApplication: "declined", cancelBooking: "cancelled", restoreBooking: "confirmed",
  cancelCalendarHold: "cancelled", respondToAssignment: data.response || data.state || "responded",
}[operationId] || data.state || current || "active");

const existingOperation = async (db, key, requestHash, traceId) => {
  const row = await db.prepare("SELECT * FROM simon_v3_operations WHERE idempotency_key = ?").bind(key).first();
  if (!row) return null;
  if (row.request_hash !== requestHash) return { error: problem(409, "version_conflict", "Idempotency key was used for a different request", traceId) };
  if (row.status === "failed") {
    return { error: problem(502, "provider_failure", "The provider did not confirm the operation", row.trace_id, "Retry only after staging provider configuration is verified.", { operation_id: row.id }) };
  }
  return { response: jsonResponse(operationFromRow(row), 202) };
};

const failedProviderOperation = async (context, route, actor, traceId, key, requestHash) => {
  const id = crypto.randomUUID();
  const timestamp = now();
  const step = [{ name: route.operationId, status: "failed", provider_confirmed: false, provider_receipt_ref: null, retry_safe: true, error: { code: "provider_failure", provider: route.provider } }];
  await context.env.APPLICATIONS_DB.batch([
    context.env.APPLICATIONS_DB.prepare(`
      INSERT INTO simon_v3_operations
        (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role,
          status, resource_refs_json, steps_json, rollback_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', '[]', ?, '{"available":false}', ?, ?)
    `).bind(id, route.operationId, key, requestHash, traceId, actor.person_id, actor.role, JSON.stringify(step), timestamp, timestamp),
    eventStatement(context.env.APPLICATIONS_DB, { traceId, route, actor, operationId: id, outcome: "failed", evidence: { provider: route.provider, provider_confirmed: false } }),
  ]);
  return problem(502, "provider_failure", `${route.provider} did not confirm the operation`, traceId, "No provider action was represented as successful.", { operation_id: id });
};

const rollback = async (context, route, actor, traceId, key, requestHash) => {
  const db = context.env.APPLICATIONS_DB;
  const source = await db.prepare("SELECT * FROM simon_v3_operations WHERE id = ?").bind(route.params.operation_id).first();
  if (!source) return problem(404, "not_found", "Operation not found", traceId);
  const definition = JSON.parse(source.rollback_json || '{"available":false}');
  if (!definition.available) return problem(409, "invalid_transition", "That operation cannot be rolled back", traceId);
  const refs = JSON.parse(source.resource_refs_json || "[]");
  const target = refs[0];
  if (!target || !source.before_json) return problem(409, "invalid_transition", "Rollback evidence is incomplete", traceId);
  const before = JSON.parse(source.before_json);
  const timestamp = now();
  const operationId = crypto.randomUUID();
  const version = Number(target.version) + 1;
  const operation = {
    id: operationId, status: "rolled_back", idempotency_key: key, trace_id: traceId,
    resource_refs: [{ kind: target.kind, id: target.id, version }],
    steps: [{ name: "restore_before_image", status: "compensated", provider_confirmed: true, provider_receipt_ref: operationId, retry_safe: true, error: null }],
    rollback: { available: false }, created_at: timestamp, completed_at: timestamp,
  };
  await db.batch([
    db.prepare("UPDATE simon_v3_resources SET version = ?, state = ?, owner_person_id = ?, data_json = ?, archived = ?, updated_at = ? WHERE id = ?")
      .bind(version, before.state, before.owner_person_id, before.data_json, before.archived, timestamp, target.id),
    db.prepare(`INSERT INTO simon_v3_operations
      (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role, status,
       resource_refs_json, steps_json, rollback_json, before_json, after_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'rolled_back', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(operationId, route.operationId, key, requestHash, traceId, actor.person_id, actor.role, JSON.stringify(operation.resource_refs), JSON.stringify(operation.steps), JSON.stringify(operation.rollback), source.after_json, source.before_json, timestamp, timestamp),
    eventStatement(db, { traceId, route, actor, resourceId: target.id, operationId, outcome: "rolled_back", evidence: { source_operation_id: source.id } }),
  ]);
  return jsonResponse(operation, 202);
};

const mutate = async (context, route, actor, traceId) => {
  const db = context.env.APPLICATIONS_DB;
  const rawIdempotencyKey = String(context.request.headers.get("idempotency-key") || "").trim();
  if (rawIdempotencyKey.length < 16 || rawIdempotencyKey.length > 200) {
    return problem(400, "validation_error", "Idempotency-Key must be between 16 and 200 characters", traceId);
  }
  const idempotencyKey = rawIdempotencyKey;
  if (!isUuid(traceId)) return problem(400, "validation_error", "A valid X-Simon-Trace-Id is required", traceId);
  const parsed = await readJson(context.request, traceId);
  if (parsed.error) return parsed.error;
  const body = parsed.value;
  const bodyShapeIsValid = hasOnlyKeys(body, ["actor", "reason", "authorization_digest", "override", "data"])
    && hasOnlyKeys(body?.actor, ["person_id", "role", "authority_grant_id"]);
  if (!bodyShapeIsValid || !actorMatches(actor, body?.actor) || !clean(body?.reason) || !body?.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return problem(400, "validation_error", "Mutation actor, reason, and data are required and must match the authenticated actor", traceId);
  }
  const requestHash = await hashJson({ operationId: route.operationId, params: route.params, body });
  const duplicate = await existingOperation(db, idempotencyKey, requestHash, traceId);
  if (duplicate?.error) return duplicate.error;
  if (duplicate?.response) return duplicate.response;
  if (route.special === "rollback") return rollback(context, route, actor, traceId, idempotencyKey, requestHash);

  const targetId = routeId(route);
  const current = targetId ? await loadResource(db, targetId) : null;
  if (targetId && (!current || current.kind !== route.kind)) return problem(404, "not_found", "Resource not found", traceId);
  if (current && !canSee(route, actor, current)) return problem(403, "forbidden", "The resource is outside this actor's scope", traceId);
  if (route.ifMatch) {
    const supplied = parseVersion(context.request.headers.get("if-match"));
    if (!supplied || supplied !== Number(current?.version)) return problem(409, "version_conflict", "If-Match does not match the current resource version", traceId);
  }
  if (route.provider) return failedProviderOperation(context, route, actor, traceId, idempotencyKey, requestHash);

  const id = targetId || (isUuid(body.data.id) ? body.data.id : crypto.randomUUID());
  const timestamp = now();
  const version = current ? Number(current.version) + 1 : 1;
  const data = { ...(current ? JSON.parse(current.data_json) : {}), ...body.data, id };
  const requestedOwner = clean(body.data.owner_person_id, 36);
  const owner = ["admin", "system"].includes(actor.role)
    ? (requestedOwner || current?.owner_person_id || null)
    : (current?.owner_person_id || actor.person_id);
  const state = stateFor(route.operationId, data, current?.state);
  const archived = route.operationId === "archiveClient" ? 1 : route.operationId === "restoreClient" ? 0 : Number(current?.archived || 0);
  const operationId = crypto.randomUUID();
  const resourceRefs = [{ kind: route.kind, id, version }];
  const steps = [{ name: route.operationId, status: "succeeded", provider_confirmed: true, provider_receipt_ref: operationId, retry_safe: true, error: null }];
  const rollbackInfo = { available: Boolean(current), kind: current ? "before_image" : null, constraints: current ? ["resource version must remain unchanged"] : [] };
  const operation = { id: operationId, status: "succeeded", idempotency_key: idempotencyKey, trace_id: traceId, resource_refs: resourceRefs, steps, rollback: rollbackInfo, created_at: timestamp, completed_at: timestamp };
  const before = current ? JSON.stringify({ state: current.state, owner_person_id: current.owner_person_id, data_json: current.data_json, archived: current.archived }) : null;
  const after = JSON.stringify({ state, owner_person_id: owner, data_json: JSON.stringify(data), archived });
  const resourceWrite = current
    ? db.prepare("UPDATE simon_v3_resources SET version = ?, state = ?, owner_person_id = ?, data_json = ?, archived = ?, updated_at = ? WHERE id = ?")
      .bind(version, state, owner, JSON.stringify(data), archived, timestamp, id)
    : db.prepare(`INSERT INTO simon_v3_resources
      (id, kind, version, state, owner_person_id, data_json, archived, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .bind(id, route.kind, state, owner, JSON.stringify(data), archived, timestamp, timestamp);
  await db.batch([
    resourceWrite,
    db.prepare(`INSERT INTO simon_v3_operations
      (id, action, idempotency_key, request_hash, trace_id, requester_person_id, requester_role, status,
       resource_refs_json, steps_json, rollback_json, before_json, after_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(operationId, route.operationId, idempotencyKey, requestHash, traceId, actor.person_id, actor.role, JSON.stringify(resourceRefs), JSON.stringify(steps), JSON.stringify(rollbackInfo), before, after, timestamp, timestamp),
    eventStatement(db, { traceId, route, actor, resourceId: id, operationId, outcome: "succeeded", evidence: { version } }),
  ]);
  return jsonResponse(operation, 202);
};

const query = async (context, route, actor, traceId) => {
  if (!isUuid(traceId)) return problem(400, "validation_error", "A valid X-Simon-Trace-Id is required", traceId);
  const parsed = await readJson(context.request, traceId);
  if (parsed.error) return parsed.error;
  const bodyShapeIsValid = hasOnlyKeys(parsed.value, ["actor", "data"])
    && hasOnlyKeys(parsed.value?.actor, ["person_id", "role", "authority_grant_id"]);
  if (!bodyShapeIsValid || !actorMatches(actor, parsed.value?.actor) || !parsed.value?.data || typeof parsed.value.data !== "object" || Array.isArray(parsed.value.data)) {
    return problem(400, "validation_error", "Query actor and data are required and must match the authenticated actor", traceId);
  }
  if (route.provider) {
    await auditRead(context, route, actor, traceId, null, "failed");
    return problem(502, "provider_failure", `${route.provider} query has no verified staging receipt`, traceId, "No provider result was represented as successful.");
  }
  return jsonResponse({ items: [], next_cursor: null });
};

export async function onRequest(context) {
  const suppliedTraceId = context.request.headers.get("x-simon-trace-id") || "";
  try {
    const route = matchSimonV3Route(context.request.method, new URL(context.request.url).pathname);
    if (!route) return problem(404, "not_found", "Simon V3 operation not found", suppliedTraceId);
    const authentication = authenticateSimonV3(context.request, context.env);
    if (authentication.error) return authentication.error;
    const { actor, traceId } = authentication;
    const denied = requireRouteAccess(route, actor, traceId);
    if (denied) return denied;
    const invalidPath = validatePathIds(route, traceId);
    if (invalidPath) return invalidPath;
    if (route.trace && !isUuid(traceId)) return problem(400, "validation_error", "A valid X-Simon-Trace-Id is required", traceId);
    if (route.mode === "mutation") return await mutate(context, route, actor, traceId);
    if (route.mode === "query") return await query(context, route, actor, traceId);
    const special = await readSpecial(context, route, actor, traceId);
    return special || await readResource(context, route, actor, traceId);
  } catch (error) {
    console.error("Simon V3 request failed safely", { error: String(error?.message || error) });
    return problem(503, "provider_failure", "Simon V3 could not verify the operation", suppliedTraceId, "No success was recorded. Retry after checking staging dependencies.");
  }
}
