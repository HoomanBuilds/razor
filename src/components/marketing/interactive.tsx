"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Menu, X } from "lucide-react";
import { RazorLogo, RazorMark } from "@/components/brand/razor-logo";
import { PaymentScene, type SceneKind } from "./visuals";

const START = "/app";

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return <header className="rm-header"><a className="rm-logo" href="/" aria-label="Razor home"><RazorLogo size={25} className="rm-brand-lockup"/></a><nav className="rm-desktop-nav" aria-label="Main navigation"><a href="#platform">Platform</a><a href="#visibility">How it works</a><a href="#compare">Compare</a><a href="#pricing">Pricing</a></nav><div className="rm-header-actions"><a href="/sign-in?next=/app" className="rm-login">Log in</a><a href={START} className="rm-button rm-button-blue rm-header-start">Get started<ArrowUpRight size={15}/></a><button className="rm-menu-button" type="button" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} aria-controls="marketing-navigation" onClick={() => setOpen(!open)}>{open ? <X size={23}/> : <Menu size={23}/>}</button></div><nav id="marketing-navigation" className="rm-mobile-nav" aria-label="Mobile navigation" hidden={!open}>{[["Platform", "#platform"], ["How it works", "#visibility"], ["Compare", "#compare"], ["Pricing", "#pricing"], ["Open workspace", START]].map(([label, href]) => <a key={href} href={href} onClick={() => setOpen(false)}>{label}<ArrowUpRight size={16}/></a>)}</nav></header>;
}

const views: { id: SceneKind; label: string; title: string; description: string; points: string[]; cta: string }[] = [
  { id:"payroll", label:"Payroll", title:"Pay the whole team.\nRespect every preference.", description:"Prepare employee and contractor pay in one place, with individual routes and separate approval steps.", points:["Build pay runs manually or import a CSV", "Keep net pay separate from routing costs", "Follow each payment through reconciliation"], cta:"Explore company payments" },
  { id:"funding", label:"Multi-asset funding", title:"Fund your way.\nKeep one clear balance.", description:"Choose from the live supported asset catalog. NEAR Intents routes funding into your company's USDC settlement balance.", points:["Review available assets, networks and quotes", "Track pending funding and confirmed credits", "Keep reserved funds separate from spendable cash"], cta:"Open your treasury" },
  { id:"receiving", label:"Payout preferences", title:"Let your people\nchoose their route.", description:"Recipients manage their own supported asset and network, with a confirmed USDC backup on a popular supported chain.", points:["Keep company-specific receiving profiles", "Review full wallet details before confirmation", "Use a backup only with consent and safe recovery"], cta:"See the recipient workspace" },
  { id:"collaboration", label:"Company clearing", title:"Working together.\nAccounting for everything.", description:"Review shared obligations with your counterparties. Keep invoice offsets, cash-backed rounds and remaining payments distinct.", points:["Identify each company's position and consent", "Review funds, commitments and residual obligations", "Keep a shared evidence trail for the round"], cta:"Explore collaboration" },
];

export function VisibilityShowcase() {
  const [selected, setSelected] = useState(0), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = views[selected];
  return <><div className="rm-showcase-tabs" role="tablist" aria-label="Explore payment workflows">{views.map((view, index) => <button key={view.id} id={`visibility-tab-${view.id}`} role="tab" type="button" aria-selected={selected === index} aria-controls={`visibility-panel-${view.id}`} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => {
    let next = index;
    if(event.key === "ArrowRight") next = (index + 1) % views.length;
    else if(event.key === "ArrowLeft") next = (index - 1 + views.length) % views.length;
    else if(event.key === "Home") next = 0;
    else if(event.key === "End") next = views.length - 1;
    else return;
    event.preventDefault();setSelected(next);tabs.current[next]?.focus();
  }} ref={node => { tabs.current[index] = node; }}>{view.label}</button>)}</div><div className="rm-showcase-panel" role="tabpanel" id={`visibility-panel-${active.id}`} aria-labelledby={`visibility-tab-${active.id}`} tabIndex={0}><div className="rm-showcase-copy"><h3>{active.title.split("\n").map((line,index)=><span key={line}>{index>0&&<br/>}{line}</span>)}</h3><p>{active.description}</p><ul>{active.points.map(point=><li key={point}><Check size={15}/>{point}</li>)}</ul><a href={active.id === "receiving" ? "/receive" : `/app?section=${active.id === "funding" ? "treasury" : active.id === "collaboration" ? "clearing" : "payroll"}`} className="rm-text-link">{active.cta}<ArrowUpRight size={16}/></a></div><PaymentScene kind={active.id}/></div></>;
}

const format = (cents: number) => new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", minimumFractionDigits:2 }).format(cents / 100);

export function FeeIllustration() {
  const [amount, setAmount] = useState(5000);
  const paypal = Number((BigInt(amount) * 349n + 50n) / 100n + 49n);
  return <div className="rm-fee-illustration"><div className="rm-fee-heading"><span>Compare one published fee component</span><span>USD illustration</span></div><div className="rm-fee-amount"><label htmlFor="comparison-amount">Example payment</label><strong>{new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(amount)}</strong></div><input id="comparison-amount" aria-label="Example payment amount in US dollars" type="range" min="500" max="25000" step="500" value={amount} onChange={event => setAmount(event.currentTarget.valueAsNumber)}/><div className="rm-range-labels"><span>$500</span><span>$25,000</span></div><div className="rm-fee-row"><div><span>PayPal US Checkout</span><small>3.49% + $0.49 receiving fee</small></div><strong>{format(paypal)}</strong></div><div className="rm-comparison-line"/><div className="rm-fee-row rm-razor-fee"><div><span><i><RazorMark size={12}/></i>Razor transfer markup</span><small>Network, conversion and subscription costs are separate</small></div><strong>$0.00</strong></div><p>Different services, different fee components. This illustrates published processing fees, not an all-in cost or guaranteed saving. PayPal Checkout is a merchant acceptance product; Razor handles crypto payments.</p><a href="https://www.paypal.com/us/business/paypal-business-fees" target="_blank" rel="noreferrer" className="rm-source-link">PayPal US merchant fee source<ArrowUpRight size={12}/></a></div>;
}
