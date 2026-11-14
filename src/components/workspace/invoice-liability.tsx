"use client";

import { usd } from "@/lib/format";

export function InvoiceLiability({ amount, delivered, setoff, funded, credit = "0", remaining }: {
  amount: string;
  delivered: string;
  setoff: string;
  funded: string;
  credit?: string;
  remaining: string;
}) {
  const values = [
    ["Original invoice", amount],
    ["Delivered funds", delivered],
    ["Accepted supplier credits", credit],
    ["Noncash debt discharge", setoff],
    ["Escrow-backed settlement", funded],
    ["Remaining liability", remaining],
  ];
  return <div className="space-y-3">
    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {values.map(([label, value]) => <div key={label} className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-1 break-words text-xl font-semibold tabular-nums">{usd(value)}</dd>
      </div>)}
    </dl>
    <p className="text-xs text-muted-foreground">Supplier credits and debt discharge reduce the invoice balance. Escrow credit rights and withdrawals remain separate from tokens delivered through this invoice&apos;s payment routes.</p>
  </div>;
}
