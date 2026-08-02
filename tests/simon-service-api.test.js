import assert from "node:assert/strict";
import test from "node:test";

import { matchingServices, serviceById } from "../functions/_lib/service-catalog.js";
import { requireSimonService } from "../functions/_lib/simon-service-auth.js";

const context = (authorization = "", overrides = {}) => ({
  request: new Request("https://preview.example.pages.dev/api/simon/services", {
    headers: authorization ? { authorization } : {},
  }),
  env: {
    APPLICATIONS_DB: {},
    SIMON_SERVICE_TOKEN: "test-service-token",
    ...overrides,
  },
});

test("service aliases resolve to one website-owned ID", () => {
  assert.deepEqual(matchingServices("vocals").map((item) => item.id), ["vocal-recording"]);
  assert.equal(serviceById("music-production").name, "Music Production");
});

test("missing and incorrect service credentials are rejected", async () => {
  assert.equal(requireSimonService(context()).status, 401);
  assert.equal(requireSimonService(context("Bearer wrong-token")).status, 401);
});

test("correct scoped service credential is accepted", () => {
  assert.equal(requireSimonService(context("Bearer test-service-token")), null);
});

test("unconfigured service boundary fails closed", () => {
  const response = requireSimonService(context("Bearer test-service-token", {
    SIMON_SERVICE_TOKEN: "",
  }));
  assert.equal(response.status, 503);
});
