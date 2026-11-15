"use client";

import { TokenLogo } from "@/components/assets/asset-identity";
import { usd } from "@/lib/format";

export function InvoiceLiability({ amount, delivered, setoff, funded, credit = "0", remaining }: {
  amount: string;
  delivered: string;
  setoff: string;
  funded: string;
  credit?: string;
  remaining: string;
}) {
  const values = [["Invoice total", amount], ["Delivered funds", delivered], ["Supplier credits", credit], ["Noncash discharge", setoff], ["Escrow-backed settlement", funded]].filter(([, value], index) => index === 0 ? amount !== remaining : BigInt(value) > 0n);
  return <div className="grid gap-5">
    <div><p className="text-xs text-muted-foreground">Remaining</p><p className="mt-2 flex items-center gap-2 text-3xl font-medium tracking-tight tabular-nums"><TokenLogo symbol="USDC" size={24} />{usd(remaining)}</p></div>
    {values.length > 0 && <dl className="grid gap-2 text-sm">{values.map(([label, value]) => <div key={label} className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="shrink-0 tabular-nums">{usd(value)}</dd></div>)}</dl>}
  </div>;
}
