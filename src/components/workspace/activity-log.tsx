"use client";

import { useState } from "react";
import { useWorkspace } from "./context";
import { useResource } from "./hooks";
import { DataTable, Empty, Panel } from "./shared";

export function ActivityLog() {
  const { base, revision, organization } = useWorkspace();
  const [page,setPage]=useState(1);
  const { data, error, loading } = useResource<{ activity: { id: string; action: string; entity_id: string; created_at: string }[];total:number;page:number;pageSize:number;hasMore:boolean }>(organization.permissions?.includes("reports:read")?`${base}/activity?page=${page}&pageSize=25`:null, revision);
  return <div className="grid gap-6"><Panel title="Activity log" tone="white" description="Company actions, approvals and payment updates." action={<a className="inline-flex rounded-full bg-muted px-4 py-2 text-xs font-medium text-foreground hover:bg-secondary" href={`/api${base}/reports/export`} download>Export CSV</a>}>{error&&<p role="alert">{error}</p>}{loading?<Empty>Loading activity...</Empty>:!data?.activity.length?<Empty>Company activity will appear here.</Empty>:<DataTable columns={["Activity","When","Reference"]}>{data.activity.map(entry=><tr key={entry.id}><td className="font-medium">{entry.action.replaceAll("."," ")}</td><td className="whitespace-nowrap text-xs text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</td><td><details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Record reference</summary><code className="mt-2 block max-w-64 break-all text-[11px]">{entry.entity_id}</code></details></td></tr>)}</DataTable>}{data&&data.total>0&&<nav aria-label="Company activity pages" className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-muted-foreground">{(data.page-1)*data.pageSize+1}-{Math.min(data.page*data.pageSize,data.total)} of {data.total} events</p><div className="flex items-center gap-4"><button type="button" disabled={loading||page<=1} className="text-primary disabled:opacity-50" onClick={()=>setPage(value=>value-1)}>Previous</button><span>Page {data.page}</span><button type="button" disabled={loading||!data.hasMore} className="text-primary disabled:opacity-50" onClick={()=>setPage(value=>value+1)}>Next</button></div></nav>}</Panel></div>;
}

