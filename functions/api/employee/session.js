import { json } from "../../_lib/admin-auth.js";
import {
  clearEmployeeSessionCookie,
  createEmployeeSessionCookie,
  employeePasswordMatches,
  employeeProfile,
  isEmployeeAuthorized,
} from "../../_lib/employee-auth.js";

export async function onRequestGet(context) {
  return json({
    authenticated: await isEmployeeAuthorized(context.request, context.env),
    employee: employeeProfile,
    configured: Boolean(context.env.EMPLOYEE_JAKE_PIN),
  });
}

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));
  if (!await employeePasswordMatches(body.password, context.env)) {
    return json({ error: context.env.EMPLOYEE_JAKE_PIN
      ? "That passcode is not correct."
      : "Jake’s dashboard passcode has not been configured yet." }, 401);
  }
  return json(
    { authenticated: true, employee: employeeProfile },
    200,
    { "set-cookie": await createEmployeeSessionCookie(context.env) },
  );
}

export function onRequestDelete() {
  return json({ authenticated: false }, 200, { "set-cookie": clearEmployeeSessionCookie() });
}
