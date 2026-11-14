"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export function WorkspaceTabs({ tabs, activeIndex, onActiveChange }: { tabs: { label: string; content: ReactNode }[]; activeIndex?: number; onActiveChange?: (index: number) => void }) {
  const [internalActive, setInternalActive] = useState(0);
  const active = Math.max(0,Math.min(tabs.length-1,activeIndex ?? internalActive));
  const [statuses, setStatuses] = useState<string[]>([]);
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const previousControlled = useRef(activeIndex);
  useEffect(() => {
    if (activeIndex !== undefined && previousControlled.current !== activeIndex) { buttons.current[active]?.scrollIntoView({block:"nearest",inline:"nearest"}); buttons.current[active]?.focus({preventScroll:true}); }
    previousControlled.current = activeIndex;
  }, [activeIndex,active]);
  useEffect(() => {
    const read = () => {
      const next = panels.current.map(panel => panel?.querySelector('[aria-busy="true"]') ? "busy" : Array.from(panel?.querySelectorAll('[role="alert"]') ?? []).some(alert => alert.textContent?.trim()) ? "error" : "");
      setStatuses(previous => previous.join() === next.join() ? previous : next);
    };
    const observer = new MutationObserver(read);
    panels.current.forEach(panel => { if (panel) observer.observe(panel, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-busy"] }); });
    read();
    return () => observer.disconnect();
  }, [tabs.length]);
  const select = (index: number) => {
    setInternalActive(index);
    onActiveChange?.(index);
    buttons.current[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return <div className="grid min-w-0 gap-6">
    <div role="tablist" aria-label="Workspace views" className="flex max-w-full gap-1 overflow-x-auto rounded-full bg-muted p-1.5 sm:w-fit">
      {tabs.map((tab, index) => <button key={tab.label} ref={node => { buttons.current[index] = node; }} type="button" role="tab" id={`${id}-tab-${index}`} aria-selected={active === index} aria-controls={`${id}-panel-${index}`} tabIndex={active === index ? 0 : -1} aria-label={`${tab.label}${statuses[index] === "busy" ? ": action in progress" : statuses[index] === "error" ? ": needs attention" : ""}`} className={`flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${active === index ? "bg-foreground text-white" : "text-muted-foreground hover:text-foreground"}`} onClick={() => select(index)} onKeyDown={event => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault();
        select(next);
        buttons.current[next]?.focus({ preventScroll: true });
      }}>{tab.label}{statuses[index] === "busy" && <LoaderCircle size={13} aria-hidden="true" className="animate-spin"/>}{statuses[index] === "error" && <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500"/>}</button>)}
    </div>
    {tabs.some((_, index) => index !== active && statuses[index] === "busy") && <p role="status" className="rounded-xl border border-primary/15 bg-secondary/50 px-4 py-3 text-xs text-primary">An action is still running in {tabs.filter((_, index) => index !== active && statuses[index] === "busy").map(tab => tab.label).join(", ")}. Return to that view to follow its progress.</p>}
    {tabs.map((tab, index) => <div key={tab.label} ref={node => { panels.current[index] = node; }} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} tabIndex={0} hidden={active !== index} className="min-w-0 outline-none">{tab.content}</div>)}
  </div>;
}
