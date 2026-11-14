"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Menu, X } from "lucide-react";
import { RazorLogo, RazorMark } from "@/components/brand/razor-logo";
import { PaymentScene, type SceneKind } from "./visuals";

const START = "/app";

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let frame = 0;
    const update = () => { setScrolled(current => window.scrollY > (current ? 48 : 100)); frame = 0; };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", scroll, { passive:true });
    return () => { window.removeEventListener("scroll", scroll); if (frame) cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return <header className="rm-header" data-scrolled={scrolled}><a className="rm-logo" href="/" aria-label="Razor home"><RazorLogo size={25} className="rm-brand-lockup"/></a><nav className="rm-desktop-nav" aria-label="Main navigation"><a href="#platform">Platform</a><a href="#visibility">How it works</a><a href="#compare">Compare</a><a href="#pricing">Pricing</a></nav><div className="rm-header-actions"><a href="/sign-in?next=/app" className="rm-login">Log in</a><a href={START} className="rm-button rm-button-blue rm-header-start">Get started<ArrowUpRight size={15}/></a><button className="rm-menu-button" type="button" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} aria-controls="marketing-navigation" onClick={() => setOpen(!open)}>{open ? <X size={23}/> : <Menu size={23}/>}</button></div><nav id="marketing-navigation" className="rm-mobile-nav" aria-label="Mobile navigation" hidden={!open}>{[["Platform", "#platform"], ["How it works", "#visibility"], ["Compare", "#compare"], ["Pricing", "#pricing"], ["Open workspace", START]].map(([label, href]) => <a key={href} href={href} onClick={() => setOpen(false)}>{label}<ArrowUpRight size={16}/></a>)}</nav></header>;
}

const views: { id: SceneKind; label: string; title: string; description: string; points: string[]; cta: string }[] = [
  { id:"payroll", label:"Payroll", title:"Pay the whole team.\nRespect every preference.", description:"One pay run for your team, with individual routes and clear approvals.", points:["Import or prepare payroll", "Track each payment to reconciliation"], cta:"Explore payroll" },
  { id:"funding", label:"Multi-asset funding", title:"Fund your way.\nKeep one clear balance.", description:"Fund with supported assets. NEAR Intents routes them into your company's USDC balance.", points:["Review a live quote", "See available and reserved funds"], cta:"Explore treasury" },
  { id:"receiving", label:"Payout preferences", title:"Let your people\nchoose their route.", description:"Recipients choose a supported asset and network, with an approved USDC backup.", points:["Company-specific receiving profiles", "Backup routes require consent"], cta:"Explore receiving" },
  { id:"collaboration", label:"Company clearing", title:"Working together.\nAccounting for everything.", description:"Review shared obligations together. Each company keeps its own funds, permissions and records.", points:["Clear positions and company consent", "Separate offsets and cash transfers"], cta:"Explore clearing" },
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
  }} ref={node => { tabs.current[index] = node; }}>{view.label}</button>)}</div><div key={active.id} className="rm-showcase-panel" role="tabpanel" id={`visibility-panel-${active.id}`} aria-labelledby={`visibility-tab-${active.id}`} tabIndex={0}><div className="rm-showcase-copy"><h3>{active.title.split("\n").map((line,index)=><span key={line}>{index>0&&<br/>}{line}</span>)}</h3><p>{active.description}</p><ul>{active.points.map(point=><li key={point}><Check size={15}/>{point}</li>)}</ul><a href={active.id === "receiving" ? "/receive" : `/app?section=${active.id === "funding" ? "treasury" : active.id === "collaboration" ? "clearing" : "payroll"}`} className="rm-text-link">{active.cta}<ArrowUpRight size={16}/></a></div><PaymentScene kind={active.id}/></div></>;
}

const format = (cents: number) => new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", minimumFractionDigits:2 }).format(cents / 100);

export function FeeIllustration() {
  const [amount, setAmount] = useState(5000);
  const paypal = Number((BigInt(amount) * 349n + 50n) / 100n + 49n);
  return <div className="rm-fee-illustration"><div className="rm-fee-heading"><span>Processing fee example</span><span>USD</span></div><div className="rm-fee-amount"><label htmlFor="comparison-amount">Example payment</label><strong>{new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(amount)}</strong></div><input id="comparison-amount" aria-label="Example payment amount in US dollars" type="range" min="500" max="25000" step="500" value={amount} onChange={event => setAmount(event.currentTarget.valueAsNumber)}/><div className="rm-range-labels"><span>$500</span><span>$25,000</span></div><div className="rm-fee-row"><div><span>PayPal US Checkout</span><small>3.49% + $0.49 receiving fee</small></div><strong>{format(paypal)}</strong></div><div className="rm-comparison-line"/><div className="rm-fee-row rm-razor-fee"><div><span><i><RazorMark size={12}/></i>Razor transfer markup</span><small>Razor platform markup only</small></div><strong>$0.00</strong></div><p>Processing fees only. Services and total costs differ.</p><a href="https://www.paypal.com/us/business/paypal-business-fees" target="_blank" rel="noreferrer" className="rm-source-link">PayPal fee source<ArrowUpRight size={12}/></a></div>;
}


export function ScrollMotion() {
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const root = document.querySelector(".razor-marketing");
    if (!root) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        if (!media.matches && typeof element.animate === "function") element.animate([
          { opacity:0, transform:"translateY(18px)" },
          { opacity:1, transform:"translateY(0)" },
        ], { duration:420, easing:"cubic-bezier(.22,1,.36,1)" });
        observer.unobserve(element);
      }
    }, { threshold:0.12, rootMargin:"0px 0px -24px 0px" });
    root.querySelectorAll(".rm-section-heading,.rm-platform-visual,.rm-showcase-panel,.rm-treasury-story,.rm-operations-grid article,.rm-price-card,.rm-principle-card,.rm-faq-layout").forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);
  return null;
}
