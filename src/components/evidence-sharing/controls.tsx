"use client";

import { useRef, useState } from "react";
import { Copy, Link2, ShieldOff } from "lucide-react";
import { api } from "@/lib/api";
import type { EvidenceShareCreation } from "@/server/evidence-sharing/service";
import { useAction } from "@/components/workspace/hooks";
import { Action, control, Field } from "@/components/workspace/shared";
import { EvidenceShareList } from "./management";

type Kind = "invoice_analysis" | "finance_proposal";
export function EvidenceShareControl({
  organizationId,
  sourceKind,
  sourceId,
  disclosure = "metadata",
}: {
  organizationId: string;
  sourceKind: Kind;
  sourceId: string;
  disclosure?: "encrypted_wire" | "metadata";
}) {
  const [result, setResult] = useState<EvidenceShareCreation | null>(null),
    [url, setUrl] = useState(""),
    [copied, setCopied] = useState(false),
    [manage, setManage] = useState(false),
    [revision, setRevision] = useState(0),
    [notice, setNotice] = useState("");
  const keys = useRef(new Map<string, string>()),
    { busy, error, run } = useAction(),
    base = `/organizations/${encodeURIComponent(organizationId)}/evidence-shares`;
  function requestKey(value: unknown) {
    const fingerprint = JSON.stringify(value),
      key = keys.current.get(fingerprint) ?? crypto.randomUUID();
    keys.current.set(fingerprint, key);
    return { key, done: () => keys.current.delete(fingerprint) };
  }
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link2 size={16} aria-hidden="true" />
        <h4 className="font-medium">Create an expiring evidence link</h4>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        This separately authorizes public distribution of a frozen
        server-exported packet. Anyone with the link can read and copy its
        disclosed metadata, reports and any encrypted wire bytes. It includes no
        invoice/payroll plaintext, raw documents, replay secrets, credentials or
        decryption keys. It is not a payment receipt or hardware-verification
        result.
      </p>
      <form
        className="grid min-w-0 grid-cols-1 gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget,
            ttlMinutes = Number(new FormData(form).get("ttl")),
            payload = {
              sourceKind,
              sourceId,
              disclosure,
              ttlMinutes,
              publicDisclosureAcknowledged: true,
            },
            request = requestKey(payload);
          void run("create", async () => {
            const value = await api<EvidenceShareCreation>(base, {
              ...payload,
              idempotencyKey: request.key,
            });
            request.done();
            setResult(value);
            setCopied(false);
            setUrl(
              value.sharePath
                ? new URL(value.sharePath, window.location.origin).toString()
                : "",
            );
            setNotice(value.notice);
            form.reset();
            setRevision((value) => value + 1);
          });
        }}
      >
        <p className="break-all text-xs">
          Frozen source: {sourceKind.replaceAll("_", " ")} / {sourceId}.
          Disclosure:{" "}
          {disclosure === "metadata"
            ? "metadata only"
            : "encrypted wire and public attestation reports"}
          .
        </p>
        <Field
          label="Link lifetime in minutes"
          hint="5 minutes to 72 hours, shortened to the retained source's expiry. At most ten active links per company; packet limit eight MiB."
        >
          <input
            name="ttl"
            type="number"
            min={5}
            max={4320}
            step={1}
            defaultValue={60}
            required
            disabled={!!busy}
            className={control}
          />
        </Field>
        <label className="flex items-start gap-2 text-xs leading-5">
          <input type="checkbox" required disabled={!!busy} className="mt-1" />I
          am authorized to disclose this exact packet publicly. I understand
          revocation and expiry only stop future link access and cannot revoke
          downloaded copies.
        </label>
        <div>
          <Action busy={busy === "create"} disabled={!!busy}>
            Create public evidence link
          </Action>
        </div>
      </form>
      <p className="text-xs leading-5 text-muted-foreground">
        A fresh sign-in within fifteen minutes is required. Sharing is an export
        right with no usage charge or subscription gate. A metadata-only packet
        cannot authenticate redacted wire bytes. If the packet is too large or
        source retention is almost over, use the existing local download.
      </p>
      {result ? (
        <div className="grid min-w-0 grid-cols-1 gap-3 rounded-lg bg-muted p-3">
          <p className="break-all text-xs">
            Share {result.share.id}. Frozen disclosure:{" "}
            {result.share.disclosure.replaceAll("_", " ")}. Expires{" "}
            {new Date(result.share.expiresAt).toLocaleString()}.
          </p>
          {url ? (
            <>
              <Field
                label="Copy this bearer link now"
                hint="Only the token hash is stored. It cannot be read back from the share list."
              >
                <input
                  className={`${control} text-xs`}
                  value={url}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                  autoComplete="off"
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Action
                  type="button"
                  disabled={!!busy}
                  onClick={() =>
                    void run("copy", async () => {
                      try {
                        await navigator.clipboard.writeText(url);
                        setCopied(true);
                        setNotice(
                          "Link copied. Anyone receiving it can download the disclosed packet.",
                        );
                      } catch {
                        setNotice(
                          "Clipboard is unavailable. Select the full link field and copy it manually.",
                        );
                      }
                    })
                  }
                >
                  <Copy size={14} aria-hidden="true" />
                  {copied ? "Copied" : "Copy link"}
                </Action>
                <Action
                  type="button"
                  disabled={!!busy}
                  busy={busy === "revoke"}
                  onClick={() => {
                    const request = requestKey({
                      action: "revoke",
                      id: result.share.id,
                    });
                    void run("revoke", async () => {
                      await api(`${base}/${result.share.id}/revoke`, {
                        idempotencyKey: request.key,
                      });
                      request.done();
                      setUrl("");
                      setNotice(
                        "Future link access revoked. Existing downloaded copies remain outside Razor's control.",
                      );
                      setRevision((value) => value + 1);
                    });
                  }}
                >
                  <ShieldOff size={14} aria-hidden="true" />
                  Revoke link
                </Action>
              </div>
            </>
          ) : (
            <p className="text-xs leading-5">
              No reusable token is available. If the original response was lost,
              manage and revoke this share before deliberately creating another
              link.
            </p>
          )}
        </div>
      ) : null}
      <Action
        type="button"
        disabled={!!busy}
        aria-expanded={manage}
        onClick={() => setManage((value) => !value)}
      >
        {manage ? "Hide link management" : "Manage existing evidence links"}
      </Action>
      {manage ? (
        <EvidenceShareList
          organizationId={organizationId}
          revision={revision}
          onChange={(id) => {
            if (result?.share.id === id) {
              setUrl("");
              setCopied(false);
            }
          }}
        />
      ) : null}
      {notice ? (
        <p role="status" className="break-words text-xs leading-5">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}{" "}
          <a href="/account" className="underline">
            Review sign-in
          </a>
        </p>
      ) : null}
    </div>
  );
}
