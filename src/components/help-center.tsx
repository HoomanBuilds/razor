"use client";

import { BookOpen, Search } from "lucide-react";
import { useState } from "react";
import { HELP_CATEGORIES, helpCategoryLabels, searchHelp, type HelpCategory } from "@/lib/help/guides";
import { control } from "./workspace/shared";

export function HelpCenter() {
 const [query,setQuery]=useState(""),[category,setCategory]=useState<HelpCategory|"all">("all");
 const guides=searchHelp(query,category);
 return <section className="grid min-w-0 grid-cols-1 gap-6" aria-label="Searchable product guides">
  <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]"><label className="grid min-w-0 gap-2 text-sm font-medium"><span className="flex items-center gap-2"><Search size={16} aria-hidden="true"/>Search help</span><input type="search" className={control} value={query} maxLength={160} onChange={event=>setQuery(event.target.value)} placeholder="Funding, payroll, private invoices..."/></label><label className="grid min-w-0 gap-2 text-sm font-medium"><span>Topic</span><select className={control} value={category} onChange={event=>setCategory(event.target.value as HelpCategory|"all")}><option value="all">All topics</option>{HELP_CATEGORIES.map(value=><option key={value} value={value}>{helpCategoryLabels[value]}</option>)}</select></label></div>
  <p role="status" className="text-sm text-muted-foreground">{guides.length} {guides.length===1?"guide":"guides"}. Company links use your signed-in workspace and its current permissions.</p>
  {!guides.length?<p className="rounded-lg border border-dashed p-6 text-sm">No guide matches these terms. Try a shorter search or another topic.</p>:<div className="grid min-w-0 grid-cols-1 gap-4">{guides.map(guide=><article key={guide.id} id={guide.id} className="min-w-0 rounded-xl border bg-card p-5"><details><summary className="cursor-pointer list-none"><p className="mb-2 text-xs text-muted-foreground">{helpCategoryLabels[guide.category]}</p><h2 className="flex items-start gap-3 text-lg font-semibold"><BookOpen size={19} aria-hidden="true" className="mt-1 shrink-0"/>{guide.title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{guide.summary}</p></summary><div className="mt-5 grid min-w-0 grid-cols-1 gap-5">{guide.sections.map(section=><section key={section.title}><h3 className="text-sm font-semibold">{section.title}</h3><ol className="mt-3 list-decimal space-y-3 pl-5 text-sm leading-6">{section.steps.map(step=><li key={step} className="break-words">{step}</li>)}</ol></section>)}<div className="flex flex-wrap gap-4">{guide.links.map(link=><a key={link.href} href={link.href} className="text-sm font-medium text-primary underline underline-offset-4">{link.label}</a>)}</div></div></details></article>)}</div>}
 </section>;
}
