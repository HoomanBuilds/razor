"use client";

import { useState } from "react";
import type { accountingOverview } from "@/server/accounting/service";
import { usd } from "@/lib/format";
import { DataTable, Empty, Panel, Status } from "./shared";

type Overview = ReturnType<typeof accountingOverview>;
type Category = "invoices" | "settlements" | "credits";
export function AccountingRegister({ data, onConnect }: { data: Overview; onConnect: () => void }) {
  const [category,setCategory] = useState<Category>("invoices"), [page,setPage] = useState(1);
  const groups = {
    invoices: data.bills.map(item => ({id:item.id,reference:item.reference,description:item.title,amount:item.amount,status:item.status})),
    settlements: data.settlements.map(item => ({id:item.id,reference:item.reference,description:"Recorded delivered entitlement",amount:item.amount,status:"recorded"})),
    credits: data.ledger.credits.map(item => ({id:item.id,reference:item.reference,description:"Accepted supplier credit",amount:item.amount,status:"accepted"})),
  };
  const records = groups[category], currentPage = Math.min(page,Math.max(1,Math.ceil(records.length/10))), start=(currentPage-1)*10;
  const descriptions = { invoices:"Original invoice face amounts, separate from the remaining liability.", settlements:"Recorded USDC installment credits, separate from wallet balances.", credits:"Accepted invoice credits. These do not move tokens or create a refund." };
  return <Panel title="Company ledger" tone="white" description="Your recorded bills, installment credits and supplier credits." action={<button type="button" onClick={onConnect} className="rounded-full bg-primary px-4 py-2 text-xs font-medium text-white">Manage connections</button>}>
    <div className="mb-5 flex flex-wrap items-center gap-2">{data.providers.map(provider => { const connected=data.connections.some(connection => connection.provider===provider.provider && connection.status==="active"); return <span key={provider.provider} className="rounded-full border border-border bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground">{provider.provider==="quickbooks"?"QuickBooks":"Xero"}: {connected?"Connected":"Not connected"}</span>; })}</div>
    <div role="group" aria-label="Ledger record category" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-muted p-1">{([['invoices','Invoices'],['settlements','Installment credits'],['credits','Supplier credits']] as const).map(([key,label]) => <button key={key} type="button" aria-pressed={category===key} onClick={() => {setCategory(key);setPage(1);}} className={`shrink-0 rounded-full px-4 py-2 text-xs font-medium ${category===key?"bg-foreground text-white":"text-muted-foreground hover:bg-white"}`}>{label}<span className="ml-2 opacity-60">{groups[key].length}</span></button>)}</div>
    <p className="mb-5 text-xs leading-5 text-muted-foreground">{descriptions[category]}</p>
    {!records.length ? <Empty>No {category==='settlements'?'installment credits':category} recorded in the loaded ledger sources.</Empty> : <DataTable columns={["Reference",category==='invoices'?"Invoice face amount":"Recorded USDC", "Status"]}>{records.slice(start,start+10).map(record => <tr key={record.id}><td><p className="font-medium">{record.reference}</p><p className="mt-1 max-w-md text-xs text-muted-foreground">{record.description}</p><details className="mt-2 text-[11px] text-muted-foreground"><summary className="cursor-pointer">Record reference</summary><code className="mt-2 block break-all">{record.id}</code></details></td><td className="whitespace-nowrap tabular-nums">{usd(record.amount)}</td><td><Status value={record.status}/></td></tr>)}</DataTable>}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>{records.length?`${start+1}-${Math.min(start+10,records.length)} of ${records.length} loaded records`:"Latest available company sources"}</span>{records.length>10 && <div className="flex items-center gap-3"><button type="button" disabled={currentPage<=1} onClick={() => setPage(currentPage-1)} className="text-primary disabled:opacity-40">Previous</button><span>Page {currentPage}</span><button type="button" disabled={start+10>=records.length} onClick={() => setPage(currentPage+1)} className="text-primary disabled:opacity-40">Next</button></div>}</div>
    {records.length===100 && <p className="mt-3 text-[11px] text-muted-foreground">This view loads up to the latest 100 sources in each category.</p>}
  </Panel>;
}
