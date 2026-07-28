const COOKIE_NAME = "rmc_admin_session";
const SESSION_SECONDS = 12 * 60 * 60;

const base64Url = (value) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const sign = async (value, secret) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  )));
};

const same = (left, right) => {
  if (!left || !right || left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
};

const cookieValue = (request) => {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match?.[1] || "";
};

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
    ...headers,
  },
});

export const createSessionCookie = async (env) => {
  const payload = base64Url(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  }));
  const signature = await sign(payload, env.ADMIN_SESSION_SECRET);
  return `${COOKIE_NAME}=${payload}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
};

export const clearSessionCookie = () => (
  `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
);

export const passwordMatches = async (password, env) => {
  if (!env.ADMIN_REVIEW_PASSWORD) return false;
  const expected = await sign("admin-password", env.ADMIN_REVIEW_PASSWORD);
  const received = await sign("admin-password", String(password || ""));
  return same(expected, received);
};

export const isAdminAuthorized = async (request, env) => {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const [payload, signature] = cookieValue(request).split(".");
  if (!payload || !signature || !same(await sign(payload, env.ADMIN_SESSION_SECRET), signature)) {
    return false;
  }
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    return Number(decoded.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
};

export const requireAdmin = async (context) => {
  if (!context.env.APPLICATIONS_DB || !context.env.APPLICATION_UPLOADS) {
    return json({ error: "The application review service is not configured." }, 503);
  }
  if (!await isAdminAuthorized(context.request, context.env)) {
    return json({ error: "Authentication required." }, 401);
  }
  return null;
};
