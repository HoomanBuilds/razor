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
  return (
    <section
      className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-4"
      aria-label="Transfer issue escalation"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-medium">Transfer issue escalation</h4>
        {escalation ? <Status value={escalation.status} /> : null}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Use this case for an unknown transfer, missing delivery or held
        recovery. Escalation records a private review request and never proves a
        transfer failed or authorizes another payment. Keep the original
        transaction identity and do not retry an unknown transfer.
      </p>
      {escalation ? (
        <div className="grid min-w-0 grid-cols-1 gap-1 text-xs">
          <p className="break-all">Reference: {escalation.id}</p>
          <p>
            Reason: {escalation.reason.replaceAll("_", " ")}. Requested{" "}
            {new Date(escalation.requestedAt).toLocaleString()}.
          </p>
          {escalation.acknowledgedAt ? (
            <p>
              An operator acknowledged this request{" "}
              {new Date(escalation.acknowledgedAt).toLocaleString()}.{" "}
              {escalation.assignedOperatorAvailable
                ? "The assigned operator remains authorized."
                : "The original operator is no longer available; another authorized operator can take over."}
            </p>
          ) : (
            <p>
              Queued for review. No operator acknowledgment or response has been
              recorded.
            </p>
          )}
          {escalation.resolvedAt ? (
            <p>
              Support escalation resolved{" "}
              {new Date(escalation.resolvedAt).toLocaleString()}. Financial
              settlement still requires its own evidence.
            </p>
          ) : null}
        </div>
      ) : null}
      {!closed && (!escalation || escalation.status === "resolved") ? (
        <form
          className="grid min-w-0 grid-cols-1 gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onRequest(String(new FormData(event.currentTarget).get("reason")));
          }}
        >
          <Field label="Transfer issue">
            <select name="reason" className={control} disabled={disabled}>
              <option value="transfer_outcome_unknown">
                Transfer outcome is unknown
              </option>
              <option value="delivery_missing">
                Expected delivery is missing
              </option>
              <option value="funding_credit_missing">
                Funding credit is missing
              </option>
              <option value="refund_recovery_held">
                Refund or recovery remains held
              </option>
            </select>
          </Field>
          <label className="flex items-start gap-2 text-xs leading-5">
            <input type="checkbox" required disabled={disabled} />I will
            preserve the original transfer and will not retry an unresolved
            payment based on this support request.
          </label>
          <div>
            <Action busy={busy} disabled={disabled}>
              Queue transfer issue for review
            </Action>
          </div>
        </form>
      ) : null}
      {closed ? (
        <p className="text-xs text-muted-foreground">
          This case is closed or resolved. Reopen it before requesting more
          transfer review; previous escalation history remains visible.
        </p>
      ) : null}
    </section>
  );
}
