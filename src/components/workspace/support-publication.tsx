"use client";

import { useEffect, useState } from "react";
import type { PublicSupportPublication } from "@/server/support/publication";
import { useResource } from "./hooks";
import { Empty, Status } from "./shared";
const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
function minute(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
export function SupportPublication({ revision = 0 }: { revision?: number }) {
  const [refreshCount, setRefreshCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setRefreshCount((value) => value + 1),
      60000,
    );
    return () => clearInterval(timer);
  }, []);
  const resource = useResource<PublicSupportPublication>(
      "/support/publication",
      revision + refreshCount,
    ),
    publication = resource.data,
    staffing =
      !resource.error && !resource.refreshing
        ? publication?.staffing
        : undefined;
  return (
    <section
      className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-4"
      aria-label="Current support availability"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Support availability</h3>
        <Status
          value={
            staffing?.available
              ? staffing.withinCoverage
                ? "published_staffed_coverage"
                : "outside_published_coverage"
              : "asynchronous_intake"
          }
        />
      </div>
      {resource.loading ? (
        <Empty>Loading current published support coverage...</Empty>
      ) : resource.error ? (
        <p role="alert" className="text-sm text-destructive">
          Support publication could not be loaded. No staffed promise is
          available. Private case intake below remains separate.
        </p>
      ) : staffing?.available ? (
        <>
          <p className="break-words text-sm leading-6">{staffing.notice}</p>
          <p className="text-xs leading-5">
            {staffing.acceptedOperatorCount.toLocaleString()} currently
            authorized operator{staffing.acceptedOperatorCount === 1 ? "" : "s"}{" "}
            accepted these terms. Published planning capacity:{" "}
            {staffing.dailyCaseCapacity.toLocaleString()} cases per UTC calendar
            day. Capacity is not a guarantee that your case has been read.
          </p>
          <ul className="grid min-w-0 grid-cols-1 gap-1 text-xs">
            {staffing.coverage.map((window, index) => (
              <li key={index} className="break-words">
                {window.days.map((day) => weekdays[day - 1]).join(", ")}:{" "}
                {minute(window.startMinute)} to {minute(window.endMinute)} (
                {staffing.timezone})
              </li>
            ))}
          </ul>
          <p className="text-xs leading-5">
            {staffing.responseTargetMinutes === null
              ? "No response-time target is published."
              : `Operational first-response target: ${staffing.responseTargetMinutes.toLocaleString()} minutes counted during published staffed coverage. This is not an SLA or guaranteed response time.`}{" "}
            This publication expires{" "}
            {new Date(staffing.expiresAt).toLocaleString()}.
          </p>
          <p className="break-all text-xs text-muted-foreground">
            Publication v{staffing.version}, reference {staffing.publicationId}.
          </p>
        </>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          {staffing?.reason ??
            "Asynchronous private case intake. Staff availability and a response time are not promised."}
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Private tickets are the only supported channel here. There is no live
        chat, dedicated account manager or outbound email notification. Transfer
        recovery is available independently of a paid plan. Refresh to read
        current coverage; an operator must acknowledge your own escalation
        separately.
      </p>
      {publication?.checkedAt ? (
        <p className="text-xs text-muted-foreground">
          Publication checked {new Date(publication.checkedAt).toLocaleString()}
          . This is a configuration check, not evidence that staff read your
          case.
        </p>
      ) : null}
    </section>
  );
}
