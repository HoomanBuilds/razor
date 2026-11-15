"use client";

import type { inspectSupportCase } from "@/server/support/service";
import { Action, control, Field, Status } from "./shared";

type Ticket = ReturnType<typeof inspectSupportCase>["case"];
export function SupportEscalation({
  ticket,
  busy,
  disabled,
  onRequest,
}: {
  ticket: Ticket;
  busy: boolean;
  disabled: boolean;
  onRequest: (reason: string) => void;
}) {
  const escalation = ticket.escalation,
    closed = ["closed", "resolved"].includes(ticket.status);
  return <section className="grid gap-5" aria-label="Transfer issue escalation">
    <div className="flex flex-wrap items-center justify-between gap-3"><h4 className="text-lg font-medium">Transfer review</h4>{escalation && <Status value={escalation.status}/>}</div>
    {escalation && <dl className="grid gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">Issue</dt><dd className="mt-1">{escalation.reason.replaceAll("_"," ")}</dd></div><div><dt className="text-xs text-muted-foreground">Requested</dt><dd className="mt-1">{new Date(escalation.requestedAt).toLocaleString()}</dd></div>{escalation.acknowledgedAt && <div><dt className="text-xs text-muted-foreground">Acknowledged</dt><dd className="mt-1">{new Date(escalation.acknowledgedAt).toLocaleString()}{!escalation.assignedOperatorAvailable && " · Awaiting reassignment"}</dd></div>}{escalation.resolvedAt && <div><dt className="text-xs text-muted-foreground">Review resolved</dt><dd className="mt-1">{new Date(escalation.resolvedAt).toLocaleString()} · Settlement evidence is separate</dd></div>}</dl>}
    {!closed && (!escalation || escalation.status==="resolved") && <form className="grid gap-4" onSubmit={event=>{event.preventDefault();onRequest(String(new FormData(event.currentTarget).get("reason")));}}><Field label="Issue"><select name="reason" className={control} disabled={disabled}><option value="transfer_outcome_unknown">Unknown transfer outcome</option><option value="delivery_missing">Missing delivery</option><option value="funding_credit_missing">Missing funding credit</option><option value="refund_recovery_held">Held refund or recovery</option></select></Field><label className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" required disabled={disabled}/>I will keep the original transfer and will not retry an unresolved payment based on this request.</label><div><Action busy={busy} disabled={disabled}>Request review</Action></div></form>}
    {closed && <p className="text-sm text-muted-foreground">Reopen this case to request a transfer review.</p>}
  </section>;
}
