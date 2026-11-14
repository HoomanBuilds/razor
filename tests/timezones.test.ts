import assert from "node:assert/strict";
import { test } from "node:test";
import { detectedTimeZone, timeZoneDetails, timeZoneOptions } from "../src/lib/timezones";

test("timezone choices use friendly cities while preserving an existing accepted IANA value", () => {
  const options = timeZoneOptions("Asia/Calcutta", "UTC");
  const kolkata = options.filter(option => option.label.startsWith("Kolkata"));
  assert.equal(kolkata.length, 1);
  assert.equal(kolkata[0].value, "Asia/Calcutta");
  assert.ok(options.some(option => option.value === "UTC"));
  assert.ok(!options.some(option => option.label.includes("Asia/Calcutta")));
});
test("timezone descriptions show the actual current-zone offset, including daylight saving", () => {
  assert.equal(timeZoneDetails("Asia/Calcutta",new Date("2026-01-01T12:00:00Z"))?.offset,"UTC+5:30");
  assert.equal(timeZoneDetails("America/New_York",new Date("2026-01-01T12:00:00Z"))?.offset,"UTC-5");
  assert.equal(timeZoneDetails("America/New_York",new Date("2026-07-01T12:00:00Z"))?.offset,"UTC-4");
  assert.equal(timeZoneDetails("invalid/zone"),null);
  assert.equal(timeZoneDetails(""),null);
});
test("automatic detection returns a usable zone and invalid saved choices are not added", () => {
  assert.ok(timeZoneDetails(detectedTimeZone()));
  assert.ok(!timeZoneOptions("invalid/zone").some(option => option.value === "invalid/zone"));
});
