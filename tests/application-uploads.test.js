import assert from "node:assert/strict";
import test from "node:test";

import { allowedApplicationFile } from "../functions/api/applications.js";

test("application uploads accept primary audio formats and browser MIME variants", () => {
  assert.equal(allowedApplicationFile({ name: "mix.wav", type: "audio/wav" }), true);
  assert.equal(allowedApplicationFile({ name: "mix.wave", type: "audio/vnd.wave" }), true);
  assert.equal(allowedApplicationFile({ name: "reference.mp3", type: "audio/mpeg" }), true);
  assert.equal(allowedApplicationFile({ name: "stems.aif", type: "audio/x-aiff" }), true);
  assert.equal(allowedApplicationFile({ name: "stems.aiff", type: "audio/aiff" }), true);
});

test("application uploads use approved extensions when browsers omit audio MIME data", () => {
  assert.equal(allowedApplicationFile({ name: "instrumental.AIF", type: "" }), true);
  assert.equal(allowedApplicationFile({ name: "instrumental.aiff", type: "application/octet-stream" }), true);
  assert.equal(allowedApplicationFile({ name: "malware.exe", type: "application/octet-stream" }), false);
  assert.equal(allowedApplicationFile({ name: "malware.exe", type: "application/x-msdownload" }), false);
});
