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
    return <section className="rounded-2xl bg-muted/50 p-4" aria-label="Support availability">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">Private support</h3><Status value={resource.error ? "unavailable" : staffing?.available ? staffing.withinCoverage ? "staffed" : "outside coverage" : "inbox only"}/></div>
    {resource.loading ? <p role="status" className="mt-3 text-xs text-muted-foreground">Checking availability...</p> : resource.error ? <p role="alert" className="mt-3 text-xs text-destructive">Coverage unavailable. You can still create a case.</p> : <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Hours and response targets</summary><div className="mt-3 grid gap-3">{staffing?.available ? <><p>{staffing.notice}</p><ul className="grid gap-2">{staffing.coverage.map((window,index)=><li key={index}>{window.days.map(day=>weekdays[day-1]).join(", ")} · {minute(window.startMinute)} to {minute(window.endMinute)} · {staffing.timezone}</li>)}</ul><p>{staffing.responseTargetMinutes===null?"No response target published.":`Target: ${staffing.responseTargetMinutes.toLocaleString()} staffed minutes. Response times are not guaranteed.`}</p><p>{staffing.acceptedOperatorCount} operators · Planning capacity {staffing.dailyCaseCapacity} cases/day</p><p>Valid until {new Date(staffing.expiresAt).toLocaleString()}</p></> : <p>{staffing?.reason || "Replies appear in your private case. No response time is promised."}</p>}{publication?.checkedAt && <p>Checked {new Date(publication.checkedAt).toLocaleString()}</p>}</div></details>}
  </section>;
}
