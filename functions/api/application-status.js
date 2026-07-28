const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  },
});

const same = (left, right) => {
  if (!left || !right || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
};

export async function onRequestPost(context) {
  if (!context.env.APPLICATIONS_DB) {
    return json({ error: "Application status is not configured." }, 503);
  }
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: "The verification request could not be read." }, 400);
  }
  const token = String(payload.token || "");
  const submittedLastFour = String(payload.lastFour || "").replace(/\D/g, "").slice(-4);
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return json({ error: "We couldn’t verify that application link and phone number." }, 404);
  }

  const application = await context.env.APPLICATIONS_DB.prepare(`
    SELECT
      id, created_at, updated_at, status, decided_at, category, service,
      service_option, preferred_date, preferred_time,
      first_name, last_name, artist_name, phone
      , deposit_amount_cents, deposit_currency, deposit_status, deposit_paid_at
    FROM applications
    WHERE public_status_token = ?
  `).bind(token).first();
  const storedLastFour = String(application?.phone || "").replace(/\D/g, "").slice(-4);
  if (!application || submittedLastFour.length !== 4 || !same(submittedLastFour, storedLastFour)) {
    return json({ error: "We couldn’t verify that application link and phone number." }, 404);
  }
  delete application.phone;

  return json({ application });
}

export function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed." }, 405);
}
