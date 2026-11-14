"use client";

import { Copy, ExternalLink, LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Panel({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="workspace-panel min-w-0 p-5 sm:p-6"><div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h2 className="text-lg font-medium tracking-tight">{title}</h2>{description && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}</div>{action}</div><div className="workspace-panel-body min-w-0">{children}</div></section>;
}

export function Field({ label, children, hint, as: Tag = "label" }: { label: string; children: ReactNode; hint?: string; as?: "label" | "div" }) {
  return <Tag className="grid min-w-0 gap-2 text-[13px] font-medium"><span>{label}</span>{children}{hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}</Tag>;
}

export const control = "min-h-11 min-w-0 w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-foreground/20 focus:border-primary focus:ring-2 focus:ring-ring/15 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60";

export function Action({ busy, children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <Button {...props} className={cn("h-auto min-h-9 max-w-full whitespace-normal", className)} aria-busy={!!busy} disabled={props.disabled || busy}>{busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}{children}</Button>;
}

export function Status({ value }: { value: string }) {
  const positive = ["paid", "settled", "active", "confirmed", "approved"].includes(value);
  const held = /hold|fail|disput|refund|cancel|exception|unfunded/.test(value);
  const labels: Record<string, string> = { credited: "Supplier credit accepted", needs_installment: "Next installment needed", needs_remainder: "Remainder needs review", needs_replacement: "Replacement needs review", ambiguous_lineage: "Payment history needs review", source_unknown: "Source transfer needs review", reported_partial: "Partial delivery reported", partially_paid: "Partially paid", approved_unfunded: "Needs funds", prepared: "Route prepared", reported_delivered: "Delivery reported", recovery_pending: "Recovery in progress", unknown: "Needs reconciliation", held: "Held for review", closed_unfunded: "Closed without transfer", pending_confirmation: "Needs confirmation", awaiting_consent: "Needs consent", setup_required: "Setup required" };
  return <span className={cn("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium before:size-1.5 before:rounded-full before:bg-current", positive ? "bg-emerald-50 text-emerald-800" : held ? "bg-amber-50 text-amber-900" : "bg-muted text-muted-foreground")}>{labels[value] ?? value.replaceAll("_", " ")}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border bg-white/60 px-5 py-12 text-center text-sm leading-6 text-muted-foreground">{children}</div>;
}

export function Address({ value, network }: { value: string; network?: string }) {
  const [copied, setCopied] = useState(false), [manual, setManual] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null), currentValue = useRef(value);
  currentValue.current = value;
  useEffect(() => {
    setCopied(false); setManual(false);
    return () => { if (timeout.current) clearTimeout(timeout.current); };
  }, [value]);
  const explorers: Record<string, string> = { near: "https://nearblocks.io/address/", mainnet: "https://nearblocks.io/address/", testnet: "https://testnet.nearblocks.io/address/", base: "https://basescan.org/address/", eth: "https://etherscan.io/address/", ethereum: "https://etherscan.io/address/", arb: "https://arbiscan.io/address/", arbitrum: "https://arbiscan.io/address/", pol: "https://polygonscan.com/address/", polygon: "https://polygonscan.com/address/", sol: "https://solscan.io/account/", solana: "https://solscan.io/account/" };
  const explorer = network && explorers[network] ? explorers[network] + encodeURIComponent(value) : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      if (currentValue.current !== value) return;
      setCopied(true); setManual(false);
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
    } catch { if (currentValue.current === value) setManual(true); }
  };
  return <span className="inline-flex max-w-full flex-wrap items-center gap-1 font-mono text-xs"><span title={value}>{value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value}</span><button type="button" className="rounded p-1 hover:bg-muted" aria-label={copied ? "Copied address" : "Copy address"} onClick={() => void copy()}><Copy size={13} /></button>{copied && <span role="status">Copied</span>}{explorer && <a href={explorer} target="_blank" rel="noreferrer" aria-label="View address in explorer"><ExternalLink size={13} /></a>}{manual && <span className="w-full"><span role="status" className="mb-1 block font-sans">Copy is unavailable. Select this address to copy it.</span><input aria-label="Full address for manual copy" className={`${control} font-mono text-xs`} readOnly value={value} onFocus={event => event.currentTarget.select()} /></span>}</span>;
}

export function DataTable({ columns, children }: { columns: string[]; children: ReactNode }) {
  return <div className="min-w-0 overflow-x-auto rounded-xl"><table className="workspace-table w-full text-left text-sm"><thead><tr>{columns.map((column) => <th key={column} scope="col" className="whitespace-nowrap px-4 py-3 text-xs font-medium text-muted-foreground">{column}</th>)}</tr></thead><tbody className="[&_td]:px-4 [&_td]:py-5 [&_td]:align-top">{children}</tbody></table></div>;
}
