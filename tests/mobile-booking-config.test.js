import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { mobileBookingConfig } from "../functions/api/mobile/config.js";

test("mobile booking config exposes client-safe booking rules", () => {
  assert.equal(mobileBookingConfig.timeZone, "America/Chicago");
  assert.equal(mobileBookingConfig.minimumLeadTimeHours, 48);
  assert.equal(mobileBookingConfig.weeklyHours.monday, null);
  assert.equal(mobileBookingConfig.weeklyHours.sunday.opens, "13:00");
  assert.deepEqual(
    mobileBookingConfig.uploads.primaryAudioExtensions,
    ["wav", "wave", "mp3", "aif", "aiff"],
  );
  assert.ok(mobileBookingConfig.services.some((service) => service.id === "vocal-recording"));
  assert.ok(mobileBookingConfig.services.every((service) => !("aliases" in service)));
});

test("published OpenAPI contract separates client and privileged operations", () => {
  const contract = JSON.parse(fs.readFileSync("right-mind-booking-openapi.json", "utf8"));
  assert.equal(contract.openapi, "3.1.0");
  assert.equal(contract.paths["/api/applications"].post["x-access-tier"], "client");
  assert.equal(
    contract.paths["/api/simon/bookings/{id}"].patch["x-access-tier"],
    "companion-server",
  );
  assert.deepEqual(
    contract.paths["/api/simon/bookings"].post.security,
    [{ ServiceBearer: [] }],
  );
  assert.doesNotMatch(JSON.stringify(contract), /SIMON_SERVICE_TOKEN\s*[:=]\s*[A-Za-z0-9_-]{16}/);
});
