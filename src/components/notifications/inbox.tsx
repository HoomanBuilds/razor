"use client";

import { api } from "@/lib/api";
import { useId, useState } from "react";
import { useAction, useResource } from "../workspace/hooks";
import { Action, control, Empty, Panel } from "../workspace/shared";

interface Inbox {page:number;pageSize:number;total:number;totalPages:number;hasMore:boolean;unreadCount:number;totalAll:number; notices: { id: string;companyName:string;organization_id:string;entity_id:string;recipient_id:string; title: string; body: string; read_at: string | null; created_at: string }[]; preferences: { emailEnabled: boolean; email: string | null; providerConfigured: boolean } }

export function NotificationInbox() {
  const filterId=useId();
  const [revision,setRevision]=useState(0),[page,setPage]=useState(1),[filter,setFilter]=useState<"all"|"unread">("all");
  const { data, loading, error: loadError } = useResource<Inbox>(`/notifications?page=${page}&filter=${filter}`,revision);
  const { run, busy, error } = useAction();
  return <Panel title="Your notifications" description="Payout profile changes and payment updates remain available after sign-in." action={<Action type="button" disabled={!!busy||loading} onClick={()=>setRevision(value=>value+1)}>Refresh notifications</Action>}>
    {(error || loadError) && <p role="alert" className="mb-4 text-sm text-destructive">{error || loadError}</p>}
    {loading ? <Empty>Loading your notifications...</Empty> : data && <div className="grid gap-4"><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={data.preferences.emailEnabled} disabled={!!busy || !data.preferences.email} onChange={event => { const emailEnabled = event.target.checked; void run("preferences", async () => { await api("/notifications/preferences", { emailEnabled }, "PUT"); setRevision(value => value + 1); }); }} /><span>Email me when an account update is available{data.preferences.email ? ` at ${data.preferences.email}` : ". Link a verified Google or email sign-in to enable this."}<span className="mt-1 block text-xs text-muted-foreground">Emails contain a sign-in link, without payment amounts, receiving addresses or private documents.</span></span></label>
      {data.preferences.emailEnabled && !data.preferences.providerConfigured && <p role="status" className="text-xs text-muted-foreground">Email delivery is not configured yet. Your in-app notifications remain available.</p>}
      <div className="flex flex-wrap items-center gap-3 text-sm"><label htmlFor={filterId}>Show updates</label><select id={filterId} className={`${control} sm:max-w-xs`} value={filter} disabled={!!busy} onChange={event=>{setFilter(event.target.value as "all"|"unread");setPage(1);}}><option value="all">All updates ({data.totalAll})</option><option value="unread">Unread updates ({data.unreadCount})</option></select></div>
      {!data.notices.length ? <Empty>{filter==="unread"?"No unread personal updates.":"No personal payment updates yet. Company operational notices appear in Activity & reports."}</Empty> : <ul className="grid gap-3">{data.notices.map(notice => <li key={notice.id} className="rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-semibold">{notice.title}</p>{!notice.read_at && <Action disabled={!!busy} busy={busy === notice.id} onClick={() => void run(notice.id, async () => { await api(`/notifications/${notice.id}/read`, {}); setRevision(value => value + 1); })}>Mark read</Action>}</div><p className="mt-2 text-xs font-medium">{notice.companyName}</p><p className="mt-2 text-sm text-muted-foreground">{notice.body}</p><a className="mt-3 inline-block text-sm text-primary" href={`/receive?${notice.entity_id===notice.recipient_id?"recipientId":"paymentId"}=${encodeURIComponent(notice.entity_id)}`}>{notice.entity_id===notice.recipient_id?"View my payer profile":"View this payment"}</a><time className="mt-2 block text-xs text-muted-foreground" dateTime={notice.created_at}>{new Date(notice.created_at).toLocaleString()}</time></li>)}</ul>}{data.total>0?<div className="flex flex-wrap items-center justify-between gap-3 text-sm"><Action type="button" disabled={!!busy||data.page<=1} onClick={()=>setPage(data.page-1)}>Previous updates</Action><span className="text-xs text-muted-foreground">Page {data.page} of {data.totalPages} - {data.total} updates</span><Action type="button" disabled={!!busy||!data.hasMore} onClick={()=>setPage(data.page+1)}>Next updates</Action></div>:null}
    </div>}
  </Panel>;
}
