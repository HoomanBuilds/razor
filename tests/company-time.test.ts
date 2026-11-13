import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addCompanyDays,
  companyCalendarShift,
  companyTimeToIso,
} from "../src/lib/company-time";
import { dateLabel } from "../src/lib/format";

test("schedules use the company zone and preserve local time across daylight changes", () => {
  assert.equal(
    companyTimeToIso("2026-11-13T09:30", "Asia/Kolkata"),
    "2026-11-13T04:00:00.000Z",
  );
  assert.equal(
    addCompanyDays("2026-10-31T13:00:00.000Z", 1, "America/New_York"),
    "2026-11-01T14:00:00.000Z",
  );
  assert.equal(
    companyCalendarShift(
      "2026-11-01T14:00:00Z",
      "2026-10-31T13:00:00Z",
      "America/New_York",
    ),
    1,
  );
  assert.throws(
    () => companyTimeToIso("2026-03-08T02:30", "America/New_York"),
    /does not exist/,
  );
  assert.throws(
    () => companyTimeToIso("2026-02-30T10:00", "UTC"),
    /does not exist/,
  );
  assert.equal(
    dateLabel("2026-11-01", "Pacific/Honolulu"),
    dateLabel("2026-11-01", "Asia/Tokyo"),
  );
});
