import assert from "node:assert/strict";
import test from "node:test";

import { applicationReviewedEvent } from "../functions/_lib/simon-notifications.js";

test("application decision text events distinguish required and waived deposits", () => {
  const required = applicationReviewedEvent({
    id: "app-required", phone: "+14025550108", deposit_status: "pending",
    public_status_token: "required",
  }, "approved", { PUBLIC_SITE_URL: "https://www.rightmindcreative.co" });
  const waived = applicationReviewedEvent({
    id: "app-waived", phone: "+14025550109", deposit_status: "waived",
    public_status_token: "waived",
  }, "approved", { PUBLIC_SITE_URL: "https://www.rightmindcreative.co" });

  assert.equal(required.application.depositStatus, "pending");
  assert.equal(waived.application.depositStatus, "waived");
});
