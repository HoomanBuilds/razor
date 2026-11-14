"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function openTaskDrawer(id: string) {
  const drawer = document.getElementById(id);
  if (drawer instanceof HTMLDialogElement && !drawer.open) drawer.showModal();
}

export function closeTaskDrawer(id: string) {
  const drawer = document.getElementById(id);
  if (drawer instanceof HTMLDialogElement && drawer.open) drawer.close();
}

export function TaskDrawer({ id, title, description, children, busySelector = '[aria-busy="true"]' }: { id: string; title: string; description?: string; children: ReactNode; busySelector?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const read = () => setBusy(Boolean(element.querySelector(busySelector)));
    const observer = new MutationObserver(read);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-busy", "data-wallet-action-busy"] });
    read();
    return () => observer.disconnect();
  }, [busySelector]);
  const close = () => { if (!dialog.current?.querySelector(busySelector)) dialog.current?.close(); };
  return <dialog ref={dialog} id={id} aria-labelledby={titleId} aria-modal="true" onCancel={event => { if (dialog.current?.querySelector(busySelector)) event.preventDefault(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }} className="fixed inset-0 m-0 ml-auto h-dvh max-h-none w-full max-w-3xl border-0 bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/25 backdrop:backdrop-blur-[2px]">
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b bg-white px-5 py-5 sm:px-8 sm:py-6"><div className="min-w-0"><p className="text-[11px] font-medium uppercase tracking-[.12em] text-muted-foreground">Razor workspace</p><h2 id={titleId} className="mt-2 text-xl font-medium tracking-tight">{title}</h2>{description && <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>}</div><button type="button" onClick={close} disabled={busy} aria-label={`Close ${title}`} className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40"><X size={18}/></button></header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-8">{children}</div>
      {busy && <p role="status" className="shrink-0 border-t bg-white px-5 py-3 text-xs text-muted-foreground sm:px-8">Finish the current action before closing this view.</p>}
    </div>
  </dialog>;
}
