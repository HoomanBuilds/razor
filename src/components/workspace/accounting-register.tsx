"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { accountingOverview } from "@/server/accounting/service";
import { usd } from "@/lib/format";
import { useWorkspace } from "./context";
import { openInvoice } from "./invoice-navigation";
import { Address, Empty, Panel, Status } from "./shared";
import { TaskDrawer, closeTaskDrawer, openTaskDrawer } from "./task-drawer";

type Overview = ReturnType<typeof accountingOverview>;
type Category = "invoices" | "settlements" | "credits";
export function AccountingRegister({ data, onConnect }: { data: Overview; onConnect: () => void }) {
  const { navigate } = useWorkspace();
  const [category, setCategory] = useState<Category>("invoices"), [page, setPage] = useState(1), [selected, setSelected] = useState("");
  const groups = {
    invoices: data.bills.map(item => ({ id: item.id, reference: item.reference, description: item.title, amount: item.amount, status: item.status, invoiceId: item.id })),
    settlements: data.settlements.map(item => ({ id: item.id, reference: item.reference, description: "", amount: item.amount, status: "recorded", invoiceId: "" })),
    credits: data.ledger.credits.map(item => ({ id: item.id, reference: item.reference, description: "", amount: item.amount, status: "accepted", invoiceId: item.bill_id })),
  };
  const records = groups[category], currentPage = Math.min(page, Math.max(1, Math.ceil(records.length / 10))), start = (currentPage - 1) * 10;
  const selectedRecord = records.find(record => record.id === selected);
  const amountLabel = category === "invoices" ? "Invoice face amount" : category === "settlements" ? "Delivered entitlement" : "Accepted credit";
  return <><Panel title="Company ledger" tone="white" action={<button type="button" onClick={onConnect} className="min-h-10 text-sm text-primary">Connections</button>}>
    <div role="group" aria-label="Ledger record category" className="dashboard-nav-scroll mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-muted p-1">{([['invoices', 'Invoices'], ['settlements', 'Installment credits'], ['credits', 'Supplier credits']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={category === key} onClick={() => { setCategory(key); setPage(1); setSelected(""); }} className={`min-h-9 shrink-0 rounded-full px-4 text-xs font-medium ${category === key ? "bg-foreground text-white" : "text-muted-foreground hover:bg-white"}`}>{label}<span className="ml-2 opacity-60">{groups[key].length}</span></button>)}</div>
    {!records.length ? <Empty>No records in this category.</Empty> : <div className="divide-y">{records.slice(start, start + 10).map(record => <article key={record.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 py-5 sm:grid-cols-[minmax(0,1fr)_auto_140px_auto]"><div className="min-w-0"><p className="truncate text-sm font-medium">{record.reference}</p>{record.description && <p className="mt-1 truncate text-xs text-muted-foreground">{record.description}</p>}</div><p className="text-right text-sm font-semibold tabular-nums">{usd(record.amount)}</p><div className="justify-self-start sm:ml-4"><Status value={record.status}/></div><button type="button" className="justify-self-end text-sm font-medium text-primary" aria-label={`Review ${record.reference}`} onClick={() => { setSelected(record.id); openTaskDrawer("accounting-ledger-record"); }}>Review<ChevronRight size={15} className="ml-1 inline"/></button></article>)}</div>}
    {records.length > 10 && <div className="mt-4 flex items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground"><span>{start + 1}-{Math.min(start + 10, records.length)} of {records.length}</span><div className="flex gap-4"><button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} className="text-primary disabled:opacity-40">Previous</button><button type="button" disabled={start + 10 >= records.length} onClick={() => setPage(currentPage + 1)} className="text-primary disabled:opacity-40">Next</button></div></div>}
    {records.length === 100 && <p className="mt-3 text-xs text-muted-foreground">Latest 100 records.</p>}
  </Panel><TaskDrawer id="accounting-ledger-record" title="Ledger record">{selectedRecord && <div key={`${category}:${selectedRecord.id}`} className="grid gap-5"><div><h3 className="text-xl font-medium">{selectedRecord.reference}</h3>{selectedRecord.description && <p className="mt-2 text-sm text-muted-foreground">{selectedRecord.description}</p>}</div><div><Status value={selectedRecord.status}/></div><div><p className="text-xs text-muted-foreground">{amountLabel}</p><p className="mt-1 text-2xl font-medium tabular-nums">{usd(selectedRecord.amount)} <span className="text-sm text-muted-foreground">USDC</span></p></div><button type="button" className="justify-self-start text-sm font-medium text-primary" onClick={() => { closeTaskDrawer("accounting-ledger-record"); if (category === "settlements") navigate("payments", selectedRecord.id); else { navigate("bills"); openInvoice(selectedRecord.invoiceId); } }}>{category === "settlements" ? "Open payment" : "Open invoice"}</button><details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Record details</summary><div className="mt-3"><Address value={selectedRecord.id} label="record ID"/></div></details></div>}</TaskDrawer></>;
}
