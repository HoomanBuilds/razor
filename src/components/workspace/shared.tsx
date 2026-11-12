"use client";

import { Copy, ExternalLink, LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Panel({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="rounded-xl border bg-card p-5 sm:p-6"><div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{title}</h2>{description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}</div>{action}</div>{children}</section>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="grid gap-2 text-sm font-medium"><span>{label}</span>{children}{hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}</label>;
}

export const control = "min-h-10 w-full rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50";

export function Action({ busy, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <Button {...props} disabled={props.disabled || busy}>{busy && <LoaderCircle className="animate-spin" />}{children}</Button>;
}

export function Status({ value }: { value: string }) {
  const positive = ["paid", "settled", "active", "confirmed", "approved"].includes(value);
  const held = /hold|fail|disput|refund|cancel|exception|unfunded/.test(value);
  return <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-medium", positive ? "bg-emerald-50 text-emerald-800" : held ? "bg-amber-50 text-amber-900" : "bg-muted text-muted-foreground")}>{value.replaceAll("_", " ")}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

export function Address({ value, network }: { value: string; network?: string }) {
  const [copied, setCopied] = useState(false);
  const explorer = network === "near" || network === "mainnet" ? `https://nearblocks.io/address/${encodeURIComponent(value)}` : network === "testnet" ? `https://testnet.nearblocks.io/address/${encodeURIComponent(value)}` : network === "base" ? `https://basescan.org/address/${encodeURIComponent(value)}` : network === "eth" || network === "ethereum" ? `https://etherscan.io/address/${encodeURIComponent(value)}` : network === "arb" || network === "arbitrum" ? `https://arbiscan.io/address/${encodeURIComponent(value)}` : network === "sol" || network === "solana" ? `https://solscan.io/account/${encodeURIComponent(value)}` : undefined;
  return <span className="inline-flex max-w-full items-center gap-1 font-mono text-xs"><span title={value}>{value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value}</span><button type="button" className="rounded p-1 hover:bg-muted" aria-label={copied ? "Copied address" : "Copy address"} onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}><Copy size={13} /></button>{copied && <span>Copied</span>}{explorer && <a href={explorer} target="_blank" rel="noreferrer" aria-label="View address in explorer"><ExternalLink size={13} /></a>}</span>;
}

export function DataTable({ columns, children }: { columns: string[]; children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b">{columns.map((column) => <th key={column} className="whitespace-nowrap px-3 py-3 text-xs font-medium text-muted-foreground first:pl-0">{column}</th>)}</tr></thead><tbody className="divide-y [&_td]:px-3 [&_td]:py-4 [&_td:first-child]:pl-0">{children}</tbody></table></div>;
}
