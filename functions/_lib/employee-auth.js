import { json } from "./admin-auth.js";

const COOKIE_NAME = "rmc_employee_session";
const SESSION_SECONDS = 12 * 60 * 60;

const base64Url = (value) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const sign = async (value, secret) => {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(value),
  )));
};

const safeEqual = (left, right) => {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const cookieValue = (request) => {
  const header = request.headers.get("cookie") || "";
  return header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`))?.[1] || "";
};

export const employeeProfile = Object.freeze({ slug: "jake-kaiser", name: "Jake Kaiser" });

export const employeePasswordMatches = async (password, env) => {
  if (!/^\d{4}$/.test(String(password || "")) || !env.EMPLOYEE_JAKE_PIN) return false;
  return safeEqual(
    await sign("jake-kaiser-pin", env.EMPLOYEE_JAKE_PIN),
    await sign("jake-kaiser-pin", String(password)),
  );
};

export const createEmployeeSessionCookie = async (env) => {
  const payload = base64Url(JSON.stringify({
    sub: employeeProfile.slug,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  }));
  const signature = await sign(payload, env.ADMIN_SESSION_SECRET);
  return `${COOKIE_NAME}=${payload}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
};

export const clearEmployeeSessionCookie = () => (
  `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
);

export const isEmployeeAuthorized = async (request, env) => {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const [payload, signature] = cookieValue(request).split(".");
  if (!payload || !signature || !safeEqual(await sign(payload, env.ADMIN_SESSION_SECRET), signature)) return false;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const data = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    return data.sub === employeeProfile.slug && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
};

export const requireEmployee = async (context) => {
  if (!context.env.APPLICATIONS_DB) return json({ error: "Employee scheduling is not configured." }, 503);
  if (!await isEmployeeAuthorized(context.request, context.env)) {
    return json({ error: "Authentication required." }, 401);
  }
  return null;
};
