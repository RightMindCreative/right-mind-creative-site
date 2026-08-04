import assert from "node:assert/strict";
import test from "node:test";

import { createSessionCookie } from "../functions/_lib/admin-auth.js";
import { createEmployeeSessionCookie, employeePasswordMatches, employeeProfile } from "../functions/_lib/employee-auth.js";
import { calendarEligibleApplication } from "../functions/_lib/employee-scheduling.js";
import { preferredStartsAt } from "../functions/api/simon/engineer-assignments.js";

test("employee dashboard is scoped to Jake Kaiser", () => {
  assert.deepEqual(employeeProfile, { slug: "jake-kaiser", name: "Jake Kaiser" });
});

test("employee passcode fails closed when unconfigured", async () => {
  assert.equal(await employeePasswordMatches("1234", {}), false);
});

test("private dashboard sessions expire after five minutes", async () => {
  const env = { ADMIN_SESSION_SECRET: "test-session-secret" };
  assert.match(await createSessionCookie(env), /Max-Age=300/);
  assert.match(await createEmployeeSessionCookie(env), /Max-Age=300/);
});

test("only dated, calendar-based applications can be assigned", () => {
  assert.equal(calendarEligibleApplication({
    category: "recording", service: "Vocal Recording Session",
    preferred_date: "2026-08-08", status: "new",
  }), true);
  assert.equal(calendarEligibleApplication({
    category: "mixing", service: "Mixing & Mastering",
    preferred_date: "2026-08-08", status: "approved",
  }), false);
  assert.equal(calendarEligibleApplication({
    category: "recording", service: "Vocal Recording Session",
    preferred_date: "2026-08-08", status: "declined",
  }), false);
});

test("Simon engineer assignments return parseable Central timestamps", () => {
  assert.equal(preferredStartsAt("2026-08-15", "2:00 PM"), "2026-08-15T14:00:00-05:00");
  assert.equal(preferredStartsAt("2026-12-15", "9:30 AM"), "2026-12-15T09:30:00-06:00");
});
