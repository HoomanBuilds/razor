"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, Field } from "./shared";

interface Feedback {
  id: string;
  workflow: string;
  category: string;
  severity: string;
  status: string;
}
const readable = (value: string) => value.replaceAll("_", " ");

export function WorkflowFeedback() {
  const { base, organization } = useWorkspace();
  return <FeedbackContent key={organization.id} base={base} />;
}
function FeedbackContent({ base }: { base: string }) {
  const [open, setOpen] = useState(false),
    [revision, setRevision] = useState(0),
    [saved, setSaved] = useState(false);
  const [submission, setSubmission] = useState<{
    key: string;
    values: string;
  } | null>(null);
  const { busy, error, run } = useAction();
  const resource = useResource<{ items: Feedback[]; retentionDays: number }>(
    open ? `${base}/insights/feedback` : null,
    revision,
  );
  return (
    <details
      className="mb-5 rounded-lg border px-4 py-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Report a problem
      </summary>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-3"
        onChange={() => setSaved(false)}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const values = {
            workflow: String(form.get("workflow")),
            category: String(form.get("category")),
            severity: String(form.get("severity")),
          };
          const serialized = JSON.stringify(values),
            key =
              submission?.values === serialized
                ? submission.key
                : crypto.randomUUID();
          setSubmission({ key, values: serialized });
          void run("submit", async () => {
            await api(`${base}/insights/feedback`, {
              ...values,
              idempotencyKey: key,
            });
            setSaved(true);
            setSubmission(null);
            setRevision((value) => value + 1);
          });
        }}
      >
        <Field label="Workflow">
          <select name="workflow" className={control} disabled={!!busy}>
            {[
              "onboarding",
              "funding",
              "payroll",
              "invoices",
              "receiving",
              "treasury",
              "accounting",
              "other",
            ].map((value) => (
              <option key={value} value={value}>
                {readable(value)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What got in the way?">
          <select name="category" className={control} disabled={!!busy}>
            {[
              "confusing",
              "too_many_steps",
              "cost_unclear",
              "slow",
              "unavailable",
              "recovery",
            ].map((value) => (
              <option key={value} value={value}>
                {readable(value)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Impact">
          <select name="severity" className={control} disabled={!!busy}>
            {["minor", "difficult", "blocked"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-3">
          <Action busy={busy === "submit"} disabled={!!busy}>
            Save report
          </Action>
        </div>
      </form>
      {saved && (
        <p role="status" className="mt-3 text-sm">
          Report saved.
        </p>
      )}
      {(error || resource.error) && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error || resource.error}
        </p>
      )}
      {resource.loading && (
        <p className="mt-3 text-sm text-muted-foreground">
          Loading your reports...
        </p>
      )}
      {!resource.error && resource.data && (
        <ul className="mt-4 grid gap-2 text-sm">
          {resource.data.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-3"
            >
              <span>
                {readable(item.workflow)}: {readable(item.category)},{" "}
                {item.severity}, {item.status}
              </span>
              <span className="flex flex-wrap gap-2">
                {item.status === "open" && (
                  <button
                    type="button"
                    disabled={!!busy || resource.refreshing}
                    className="underline disabled:opacity-50"
                    onClick={() =>
                      void run(item.id, async () => {
                        await api(
                          `${base}/insights/feedback/${item.id}/resolve`,
                          {},
                        );
                        setRevision((value) => value + 1);
                      })
                    }
                  >
                    Mark resolved
                  </button>
                )}
                <button
                  type="button"
                  disabled={!!busy || resource.refreshing}
                  className="underline disabled:opacity-50"
                  onClick={() =>
                    void run(item.id, async () => {
                      await api(
                        `${base}/insights/feedback/${item.id}`,
                        undefined,
                        "DELETE",
                      );
                      setRevision((value) => value + 1);
                    })
                  }
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function WorkflowFeedbackSummary() {
  const { base, revision } = useWorkspace();
  const resource = useResource<{
    groups: {
      workflow: string;
      category: string;
      severity: string;
      status: string;
      count: number;
    }[];
    notice: string;
  }>(`${base}/insights/feedback/summary`, revision);
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Company workflow friction
      </summary>
      {resource.loading && (
        <p className="mt-3 text-sm">Loading workflow reports...</p>
      )}
      {resource.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {resource.error}
        </p>
      )}
      {!resource.error && resource.data && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-xs leading-5 text-muted-foreground">
            {resource.data.notice}
          </p>
          {!resource.data.groups.length ? (
            <p>No workflow reports in the last 30 days.</p>
          ) : (
            <ul className="space-y-2">
              {resource.data.groups.map((group) => (
                <li
                  key={`${group.workflow}:${group.category}:${group.severity}:${group.status}`}
                >
                  {readable(group.workflow)}: {readable(group.category)},{" "}
                  {group.severity}, {group.status}:{" "}
                  {group.count.toLocaleString("en-US")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  );
}
