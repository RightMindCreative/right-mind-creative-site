import assert from "node:assert/strict";
import test from "node:test";

import { employeePasswordMatches, employeeProfile } from "../functions/_lib/employee-auth.js";
import { calendarEligibleApplication } from "../functions/_lib/employee-scheduling.js";

test("employee dashboard is scoped to Jake Kaiser", () => {
  assert.deepEqual(employeeProfile, { slug: "jake-kaiser", name: "Jake Kaiser" });
});

test("employee passcode fails closed when unconfigured", async () => {
  assert.equal(await employeePasswordMatches("1234", {}), false);
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
