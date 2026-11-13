"use client";

import { api } from "@/lib/api";
import { useState } from "react";
import { useAction, useResource } from "../workspace/hooks";
import { Action, Empty, Panel } from "../workspace/shared";

interface Inbox { notices: { id: string; title: string; body: string; read_at: string | null; created_at: string }[]; preferences: { emailEnabled: boolean; email: string | null; providerConfigured: boolean } }

export function NotificationInbox() {
  const [revision, setRevision] = useState(0);
  const { data, loading, error: loadError } = useResource<Inbox>("/notifications", revision);
  const { run, busy, error } = useAction();
  return <Panel title="Your notifications" description="Payout profile changes and payment updates remain available after sign-in.">
    {(error || loadError) && <p role="alert" className="mb-4 text-sm text-destructive">{error || loadError}</p>}
    {loading ? <Empty>Loading your notifications...</Empty> : data && <div className="grid gap-4"><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={data.preferences.emailEnabled} disabled={!!busy || !data.preferences.email} onChange={event => { const emailEnabled = event.target.checked; void run("preferences", async () => { await api("/notifications/preferences", { emailEnabled }, "PUT"); setRevision(value => value + 1); }); }} /><span>Email me when an account update is available{data.preferences.email ? ` at ${data.preferences.email}` : ". Link a verified Google or email sign-in to enable this."}<span className="mt-1 block text-xs text-muted-foreground">Emails contain a sign-in link, without payment amounts, receiving addresses or private documents.</span></span></label>
      {data.preferences.emailEnabled && !data.preferences.providerConfigured && <p role="status" className="text-xs text-muted-foreground">Email delivery is not configured yet. Your in-app notifications remain available.</p>}
      {!data.notices.length ? <Empty>No personal payment updates yet. Company operational notices appear in Activity &amp; reports.</Empty> : <ul className="grid gap-3">{data.notices.map(notice => <li key={notice.id} className="rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-semibold">{notice.title}</p>{!notice.read_at && <Action disabled={!!busy} busy={busy === notice.id} onClick={() => void run(notice.id, async () => { await api(`/notifications/${notice.id}/read`, {}); setRevision(value => value + 1); })}>Mark read</Action>}</div><p className="mt-2 text-sm text-muted-foreground">{notice.body}</p><time className="mt-2 block text-xs text-muted-foreground" dateTime={notice.created_at}>{new Date(notice.created_at).toLocaleString()}</time></li>)}</ul>}
    </div>}
  </Panel>;
}
