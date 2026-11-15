"use client";

import { useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { TaskDrawer, closeTaskDrawer, openTaskDrawer } from "@/components/workspace/task-drawer";
import { api } from "@/lib/api";
import type { EvidenceSharePage } from "@/server/evidence-sharing/service";
import { useWorkspace } from "@/components/workspace/context";
import { useAction, useResource } from "@/components/workspace/hooks";
import { Action, Address, Empty, Panel, Status } from "@/components/workspace/shared";

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
  const [selectedId, setSelectedId] = useState(""), [confirmDelete, setConfirmDelete] = useState(false);
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
      closeTaskDrawer("evidence-share-details", true);
      setConfirmDelete(false);
      onChange?.(id, kind);
      setOwnRevision((value) => value + 1);
      setNotice(
        kind === "delete"
          ? "Hosted share deleted. Existing copies are unaffected."
          : "Link revoked. Existing copies are unaffected.",
      );
    });
  }
  const share = resource.data?.shares.find(item => item.id === selectedId);
  const shareLabel = (value: string) => value.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
  const feedback = <>{(resource.error || error) && <p role="alert" className="text-sm text-destructive">{resource.error || error}</p>}{notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}</>;
  return <><div className="grid min-w-0 gap-4"><div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{resource.data ? `${resource.data.activeCompanyShares} / ${resource.data.maxActiveCompanyShares} active links` : "Company links"}</p><button type="button" disabled={!!busy || resource.refreshing} aria-label="Refresh evidence links" className="grid size-10 place-items-center rounded-full bg-muted disabled:opacity-40" onClick={() => setOwnRevision(value => value + 1)}><RefreshCw size={15}/></button></div>
    {resource.loading ? <Empty>Loading links...</Empty> : resource.data?.shares.length ? <div className="divide-y">{resource.data.shares.map(item => <article key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]"><div><p className="text-sm font-medium">{shareLabel(item.sourceKind)}</p><p className="mt-1 text-xs text-muted-foreground">{item.disclosure === "metadata" ? "Metadata only" : "Encrypted evidence"} · Expires {new Date(item.expiresAt).toLocaleDateString()}</p></div><div><Status value={item.status}/></div><button type="button" disabled={!!busy} className="col-span-2 justify-self-end text-sm font-medium text-primary sm:col-span-1" onClick={() => { setSelectedId(item.id); setConfirmDelete(false); openTaskDrawer("evidence-share-details"); }}>Manage<ChevronRight size={15} className="ml-1 inline"/></button></article>)}</div> : !resource.error ? <Empty>No evidence links yet.</Empty> : null}
    {resource.data && (page > 1 || resource.data.hasMore) && <nav aria-label="Evidence link pages" className="flex items-center justify-between gap-3 border-t pt-4 text-xs"><span className="text-muted-foreground">Page {page}</span><div className="flex gap-4"><button type="button" disabled={!!busy || resource.refreshing || page === 1} onClick={() => setPage(value => value - 1)} className="text-primary disabled:opacity-40">Previous</button><button type="button" disabled={!!busy || resource.refreshing || !resource.data.hasMore} onClick={() => setPage(value => value + 1)} className="text-primary disabled:opacity-40">Next</button></div></nav>}
    {feedback}
  </div><TaskDrawer id="evidence-share-details" title={confirmDelete ? "Delete evidence share" : "Evidence link"}><div aria-busy={!!busy} className="grid gap-5">{share && <div key={share.id} className="grid gap-5"><header className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-medium">{shareLabel(share.sourceKind)}</h3><Status value={share.status}/></header>{confirmDelete ? <><p className="text-sm">Delete this hosted snapshot and its source reference?</p><p className="text-xs leading-5 text-muted-foreground">Future access stops. The original company record and downloaded copies remain. Minimal audit and replay metadata is retained.</p><div className="flex items-center justify-between gap-4"><button type="button" disabled={!!busy} className="text-sm text-muted-foreground" onClick={() => setConfirmDelete(false)}>Cancel</button><Action type="button" disabled={!!busy} busy={busy === `delete:${share.id}`} onClick={() => action(share.id, "delete")}>Delete share</Action></div></> : <><dl className="grid gap-4 text-sm"><div><dt className="text-xs text-muted-foreground">Shared content</dt><dd className="mt-1">{share.disclosure === "metadata" ? "Metadata only" : "Encrypted wire and public attestation reports"}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Expires</dt><dd className="text-right">{new Date(share.expiresAt).toLocaleString()}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Created</dt><dd className="text-right">{new Date(share.createdAt).toLocaleString()}</dd></div></dl><p className="text-xs text-muted-foreground">Revocation stops future access. Downloaded copies cannot be revoked.</p><div className="flex flex-wrap items-center gap-4">{share.status === "active" && <Action type="button" disabled={!!busy} busy={busy === `revoke:${share.id}`} onClick={() => action(share.id, "revoke")}>Revoke access</Action>}{share.status !== "deleted" && <button type="button" disabled={!!busy} className="text-sm text-destructive" onClick={() => setConfirmDelete(true)}>Delete hosted share</button>}</div><details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Technical details</summary><dl className="mt-4 grid gap-4"><div><dt className="mb-1 text-muted-foreground">Share ID</dt><dd><Address value={share.id} label="share ID"/></dd></div><div><dt className="mb-1 text-muted-foreground">Source</dt><dd>{share.sourceId ? <Address value={share.sourceId} label="source ID"/> : "Reference deleted"}</dd></div><div><dt className="mb-1 text-muted-foreground">Packet SHA-256</dt><dd><Address value={share.packetSha256} label="packet digest"/></dd></div><div><dt className="text-muted-foreground">Packet size</dt><dd>{share.packetBytes.toLocaleString()} bytes</dd></div></dl><p className="mt-4 text-muted-foreground">The digest identifies the frozen packet; it is not settlement or hardware verification. Link tokens and URLs are never read back.</p></details></>}</div>}{feedback}</div></TaskDrawer></>;
}
export function EvidenceSharesPanel() {
  const { organization, session, revision } = useWorkspace();
  return <Panel title="Evidence sharing" tone="white"><EvidenceShareList key={`${organization.id}:${session.user.id}`} organizationId={organization.id} revision={revision}/></Panel>;
}
