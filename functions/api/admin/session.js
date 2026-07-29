import {
  clearSessionCookie,
  createSessionCookie,
  isAdminAuthorized,
  json,
  passwordMatches,
} from "../../_lib/admin-auth.js";

export async function onRequestGet(context) {
  return json({ authenticated: await isAdminAuthorized(context.request, context.env) });
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "Enter the 4-digit review passcode." }, 400);
  }
  if (!await passwordMatches(body.password, context.env)) {
    return json({ error: "That passcode is not correct." }, 401);
  }
  return json(
    { authenticated: true },
    200,
    { "set-cookie": await createSessionCookie(context.env) },
  );
}

export function onRequestDelete() {
  return json(
    { authenticated: false },
    200,
    { "set-cookie": clearSessionCookie() },
  );
}
