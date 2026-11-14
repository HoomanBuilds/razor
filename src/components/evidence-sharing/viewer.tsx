"use client";

import { RequestError } from "@/lib/api";
import { useState } from "react";
import { Download, FileJson, RefreshCw } from "lucide-react";
import { portablePacketSchema } from "@/lib/verification/packet";
import type { PublicEvidenceShare } from "@/server/evidence-sharing/service";
import { useAction, useResource } from "@/components/workspace/hooks";
import { Action, Empty, Panel, Status } from "@/components/workspace/shared";

export function PublicEvidenceShareViewer({ token }: { token: string }) {
  const [revision, setRevision] = useState(0),
    [notice, setNotice] = useState("");
  const resource = useResource<PublicEvidenceShare>(
      /^[A-Za-z0-9_-]{43}$/.test(token) ? `/evidence-shares/${token}` : null,
      revision,
    ),
    { busy, error, run } = useAction();
  const value = !resource.error ? resource.data : null;
  async function download() {
    if (!value) return;
    const packet = portablePacketSchema.parse(value.packet),
      json = JSON.stringify(packet),
      bytes = new TextEncoder().encode(json);
    if (
      bytes.length > 8 * 1024 * 1024 ||
      bytes.length !== value.share.packetBytes
    )
      throw new RequestError(
        "The shared packet size differs from its frozen snapshot",
        409,
        "EVIDENCE_SHARE_BYTES_CHANGED",
      );
    const actual = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== value.share.packetSha256)
      throw new RequestError(
        "The shared packet differs from its frozen snapshot digest",
        409,
        "EVIDENCE_SHARE_BYTES_CHANGED",
      );
    const url = URL.createObjectURL(
        new Blob([json], { type: "application/json" }),
      ),
      link = document.createElement("a");
    try {
      link.href = url;
      link.download = "razor-shared-evidence-v1.json";
      link.click();
      setNotice(
        "Frozen packet downloaded locally. Link revocation cannot revoke this copy. Load it in the local verifier with independently reviewed trust inputs.",
      );
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  return (
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <Panel
        title="Shared portable evidence"
        description="This bearer link exposes only its deliberately frozen disclosure. Opening it does not verify hardware identity, source execution or destination settlement."
      >
        {resource.loading ? (
          <Empty>Loading the shared evidence snapshot...</Empty>
        ) : !value ? (
          <Empty>
            This evidence link is unavailable. It may be missing, revoked,
            expired or no longer authorized by its retained source.
          </Empty>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <FileJson size={20} aria-hidden="true" />
              <h2 className="break-words font-medium">
                {value.packet.subject.kind.replaceAll("_", " ")}
              </h2>
              <Status value="verification_not_run" />
            </div>
            <p className="text-sm leading-6">{value.share.scope}</p>
            <dl className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">
                  Disclosed source identifier
                </dt>
                <dd className="mt-1 break-all text-sm">
                  {value.packet.subject.id}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Frozen disclosure
                </dt>
                <dd className="mt-1 text-sm">
                  {value.packet.disclosure.mode === "metadata"
                    ? "Metadata only; signed wire bytes redacted"
                    : "Encrypted signed wire bytes and public reports where retained"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Link access ends
                </dt>
                <dd className="mt-1 text-sm">
                  {new Date(value.share.expiresAt).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Snapshot exported
                </dt>
                <dd className="mt-1 text-sm">
                  {new Date(value.packet.exportedAt).toLocaleString()}
                </dd>
              </div>
            </dl>
            <p className="break-all text-xs text-muted-foreground">
              Frozen packet SHA-256: {value.share.packetSha256}.{" "}
              {value.share.packetBytes.toLocaleString()} bytes. The digest
              identifies bytes, not a verified financial outcome.
            </p>
            <div className="flex flex-wrap gap-3">
              <Action
                type="button"
                busy={busy === "download"}
                disabled={!!busy || resource.refreshing}
                onClick={() => void run("download", download)}
              >
                <Download size={15} aria-hidden="true" />
                Download frozen packet
              </Action>
              <a
                href="/verify"
                rel="noreferrer"
                className="w-fit py-2 text-sm text-primary underline underline-offset-4"
              >
                Open local evidence verifier
              </a>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              The local verifier accepts the downloaded file. Select your own
              trusted source identities, measurements, collateral and RPCs
              before enabling independent checks. This page performs no
              attestation, chain or third-party queries. It does not load
              decryption keys or replay secrets.
            </p>
            <details className="min-w-0 rounded-lg border p-4">
              <summary className="cursor-pointer text-sm">
                Exact disclosed scope and limitations
              </summary>
              <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 text-xs leading-5">
                <p>
                  Schema {value.packet.schema}, version {value.packet.version}.
                  Network {value.packet.network ?? "not asserted"}. Inference
                  model {value.packet.inference?.model ?? "not retained"}.
                  Signed request bytes{" "}
                  {value.packet.inference?.request?.base64
                    ? "included as encrypted wire"
                    : "unavailable or redacted"}
                  ; signed response bytes{" "}
                  {value.packet.inference?.response?.base64
                    ? "included as encrypted wire"
                    : "unavailable or redacted"}
                  .
                </p>
                <p>
                  Plaintext included: no. Decryption keys included: no. Hardware
                  verification: not checked. Source execution: not checked.
                  Destination settlement: not checked.
                </p>
                <ul className="grid min-w-0 grid-cols-1 gap-2">
                  {value.packet.limitations.map((limitation, index) => (
                    <li key={index} className="break-words">
                      {limitation}
                    </li>
                  ))}
                </ul>
                <p className="break-words">{value.notice}</p>
              </div>
            </details>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          <Action
            type="button"
            disabled={!!busy || resource.refreshing}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            Refresh link availability
          </Action>
          <a
            href="/help"
            rel="noreferrer"
            className="w-fit py-2 text-sm text-primary underline underline-offset-4"
          >
            Product and verification help
          </a>
        </div>
        {notice ? (
          <p role="status" className="mt-4 text-xs leading-5">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </Panel>
      <p className="text-xs leading-5 text-muted-foreground">
        Revoking, deleting or expiring this link stops future hosted access. A
        packet already opened in memory, downloaded, photographed or copied
        cannot be remotely revoked. Bearer URLs should only be sent to intended
        reviewers.
      </p>
    </div>
  );
}
