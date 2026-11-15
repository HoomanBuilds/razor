"use client";

import { useState } from "react";
import { useWorkspace } from "./context";
import { useResource } from "./hooks";
import { Address, Empty, Panel } from "./shared";

const eventLabel = (value: string) => value.replaceAll(".", " ").replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, letter => letter.toUpperCase());
export function ActivityLog() {
  const { base, revision, organization } = useWorkspace();
  const [page, setPage] = useState(1);
  const { data, error, loading } = useResource<{ activity: { id: string; action: string; entity_id: string; created_at: string }[]; total: number; page: number; pageSize: number; hasMore: boolean }>(organization.permissions?.includes("reports:read") ? `${base}/activity?page=${page}&pageSize=25` : null, revision);
  return <Panel title="Activity" tone="white" action={<a className="inline-flex min-h-10 items-center rounded-full bg-muted px-4 text-xs font-medium hover:bg-secondary" href={`/api${base}/reports/export`} download>Export CSV</a>}>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <Empty>Loading activity...</Empty> : !data?.activity.length ? <Empty>No activity yet.</Empty> : <div className="divide-y">{data.activity.map(entry => <details key={entry.id} className="py-4"><summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{eventLabel(entry.action)}</span><time dateTime={entry.created_at} className="text-xs text-muted-foreground">{new Date(entry.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: organization.timezone, timeZoneName: "short" })}</time></summary><dl className="mt-4 grid gap-3 text-xs"><div><dt className="mb-1 text-muted-foreground">Record</dt><dd><Address value={entry.entity_id} label="record ID"/></dd></div><div><dt className="mb-1 text-muted-foreground">Event</dt><dd>{entry.action}</dd></div></dl></details>)}</div>}
    {data && data.total > data.pageSize && <nav aria-label="Company activity pages" className="mt-5 flex items-center justify-between gap-3 border-t pt-4 text-xs"><p className="text-muted-foreground">{(data.page - 1) * data.pageSize + 1}-{Math.min(data.page * data.pageSize, data.total)} of {data.total}</p><div className="flex gap-4"><button type="button" disabled={loading || page <= 1} className="text-primary disabled:opacity-40" onClick={() => setPage(value => value - 1)}>Previous</button><button type="button" disabled={loading || !data.hasMore} className="text-primary disabled:opacity-40" onClick={() => setPage(value => value + 1)}>Next</button></div></nav>}
  </Panel>;
}
