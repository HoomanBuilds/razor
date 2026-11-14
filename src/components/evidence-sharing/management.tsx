"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { EvidenceSharePage } from "@/server/evidence-sharing/service";
import { useWorkspace } from "@/components/workspace/context";
import { useAction, useResource } from "@/components/workspace/hooks";
import { Action, Empty, Panel, Status } from "@/components/workspace/shared";

export function EvidenceShareList({
  organizationId,
  revision = 0,
  onChange,
}: {
  organizationId: string;
  revision?: number;
  onChange?: (id: string, kind: "revoke" | "delete") => void;
}) {
  const [page, setPage] = useState(1),
    [ownRevision, setOwnRevision] = useState(0),
    [notice, setNotice] = useState("");
  const keys = useRef(new Map<string, string>()),
    { busy, error, run } = useAction(),
    base = `/organizations/${encodeURIComponent(organizationId)}/evidence-shares`;
  const resource = useResource<EvidenceSharePage>(
    `${base}?page=${page}`,
    revision + ownRevision,
  );
  function action(id: string, kind: "revoke" | "delete") {
    const identity = `${kind}:${id}`,
      key = keys.current.get(identity) ?? crypto.randomUUID();
    keys.current.set(identity, key);
    void run(identity, async () => {
      await api(
        kind === "revoke" ? `${base}/${id}/revoke` : `${base}/${id}`,
        {
          idempotencyKey: key,
          ...(kind === "delete" ? { deleteSnapshotAcknowledged: true } : {}),
        },
        kind === "delete" ? "DELETE" : "POST",
      );
      keys.current.delete(identity);
      onChange?.(id, kind);
      setOwnRevision((value) => value + 1);
      setNotice(
        kind === "delete"
          ? "Hosted snapshot and source reference removed. Minimal replay/audit metadata remains. Copied files cannot be revoked."
          : "Future link access revoked and hosted snapshot removed. Copied files remain outside Razor's control.",
      );
    });
  }
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Company evidence links</h3>
        <Action
          type="button"
          disabled={!!busy || resource.refreshing}
          onClick={() => setOwnRevision((value) => value + 1)}
        >
          Refresh links
        </Action>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        You can manage your own links; the current company owner can manage
        every company link. Tokens and URLs are never read back. Creation
        permissions are checked against the original source, and public access
        ends when that source expires, is deleted or the creator loses required
        access. Local downloaded copies have their own retention.
      </p>
      {resource.loading ? (
        <Empty>Loading evidence links...</Empty>
      ) : resource.data ? (
        <>
          <p className="text-xs tabular-nums">
            {resource.data.activeCompanyShares} /{" "}
            {resource.data.maxActiveCompanyShares} active company links.
            Eight-MiB hosted packet limit.
          </p>
          {resource.data.shares.length ? (
            <div className="grid min-w-0 grid-cols-1 gap-3">
              {resource.data.shares.map((share) => (
                <article
                  key={share.id}
                  className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-4"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                    <p className="break-all text-sm font-medium">
                      {share.sourceKind.replaceAll("_", " ")}
                    </p>
                    <Status value={share.status} />
                  </div>
                  <p className="break-all text-xs text-muted-foreground">
                    Share {share.id}
                    {share.sourceId
                      ? ` / Source ${share.sourceId}`
                      : " / Source reference deleted"}
                  </p>
                  <p className="text-xs">
                    {share.disclosure === "metadata"
                      ? "Metadata only"
                      : "Encrypted wire and public attestation reports"}
                    . Expires {new Date(share.expiresAt).toLocaleString()}.
                    Created {new Date(share.createdAt).toLocaleString()}.
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    Frozen packet SHA-256: {share.packetSha256}.{" "}
                    {share.packetBytes.toLocaleString()} bytes. This digest is
                    not a hardware or settlement verification.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {share.status === "active" ? (
                      <Action
                        type="button"
                        disabled={!!busy}
                        busy={busy === `revoke:${share.id}`}
                        onClick={() => action(share.id, "revoke")}
                      >
                        Revoke future link access
                      </Action>
                    ) : null}
                    {share.status !== "deleted" ? (
                      <details className="min-w-0">
                        <summary className="cursor-pointer py-2 text-xs">
                          Delete hosted snapshot and source reference
                        </summary>
                        <p className="my-2 max-w-lg text-xs leading-5 text-muted-foreground">
                          This also stops future link access. Minimal opaque
                          audit/replay metadata remains; the original company
                          record and copied files are unaffected.
                        </p>
                        <Action
                          type="button"
                          disabled={!!busy}
                          busy={busy === `delete:${share.id}`}
                          onClick={() => action(share.id, "delete")}
                        >
                          Delete this hosted share
                        </Action>
                      </details>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty>
              No evidence links have been created. Use a retained invoice
              analysis or finance proposal's portable export controls to choose
              an exact disclosure.
            </Empty>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Action
              type="button"
              disabled={!!busy || resource.refreshing || page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous links
            </Action>
            <span className="text-xs">Page {page}</span>
            <Action
              type="button"
              disabled={!!busy || resource.refreshing || !resource.data.hasMore}
              onClick={() => setPage((value) => value + 1)}
            >
              Next links
            </Action>
          </div>
        </>
      ) : null}
      {resource.error || error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {resource.error || error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs leading-5">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
export function EvidenceSharesPanel() {
  const { organization, session, revision } = useWorkspace();
  return (
    <Panel
      title="Evidence sharing"
      description="Explicit public disclosure of frozen portable evidence, with expiring and revocable hosted links. Sharing never grants financial authority."
    >
      <EvidenceShareList
        key={`${organization.id}:${session.user.id}`}
        organizationId={organization.id}
        revision={revision}
      />
    </Panel>
  );
}
