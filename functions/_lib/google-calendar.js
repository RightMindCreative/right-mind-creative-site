const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FREE_BUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const GOOGLE_CALENDAR_SCOPE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

const encodeBase64Url = (value) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const importPrivateKey = async (pem) => {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
};

const createAssertion = async (clientEmail, privateKey, delegatedUser) => {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = {
    iss: clientEmail,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  if (delegatedUser) claims.sub = delegatedUser;
  const claim = encodeBase64Url(JSON.stringify(claims));
  const unsigned = `${header}.${claim}`;
  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
};

const getAccessToken = async (env) => {
  const assertion = await createAssertion(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    env.GOOGLE_IMPERSONATED_USER,
  );
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google token request failed (${response.status}).`);
  const result = await response.json();
  return result.access_token;
};

export const calendarIsConfigured = (env) => Boolean(
  env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  && env.GOOGLE_CALENDAR_ID,
);

export const getBusyPeriods = async (env, timeMin, timeMax) => {
  const accessToken = await getAccessToken(env);
  const response = await fetch(GOOGLE_FREE_BUSY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: env.BOOKING_TIME_ZONE || "America/Chicago",
      items: [{ id: env.GOOGLE_CALENDAR_ID }],
    }),
  });
  if (!response.ok) throw new Error(`Google free/busy request failed (${response.status}).`);
  const result = await response.json();
  const calendar = result.calendars?.[env.GOOGLE_CALENDAR_ID];
  if (!calendar || calendar.errors?.length) throw new Error("Google Calendar could not be read.");
  return calendar.busy || [];
};

export const createCalendarEvent = async (env, event) => {
  const accessToken = await getAccessToken(env);
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=none`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google event creation failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json();
};

export const updateCalendarEvent = async (env, eventId, changes) => {
  const accessToken = await getAccessToken(env);
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(changes),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google event update failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json();
};

export const deleteCalendarEvent = async (env, eventId) => {
  const accessToken = await getAccessToken(env);
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    const detail = await response.text();
    throw new Error(`Google event deletion failed (${response.status}): ${detail.slice(0, 500)}`);
  }
};
