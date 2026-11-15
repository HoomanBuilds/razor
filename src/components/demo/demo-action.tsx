"use client";

import { useRef, useState, type ReactNode } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { DEMO_STATE_EVENT, demoRequestHeaders, isPublicDemo } from "@/lib/demo-scope";

export interface DemoState {
  fictional: true;
  noBroadcast: true;
  profile: "owner" | "maya" | "leo";
  profiles: { id: "owner" | "maya" | "leo"; name: string; userId: string }[];
  companies: { id: string; name: string; account: string }[];
  runId: string;
  paymentIds: Record<string, string>;
  recipientIds: Record<string, string>;
  funded: boolean;
  settled: boolean;
}
export type DemoActionName = "fund" | "approve-payroll" | "settle-payroll" | "settle-payment" | "reset" | "profile";

export async function demoAction(action: DemoActionName, options: Record<string, string> = {}, publish = true) {
  if (!isPublicDemo()) throw new Error("Open the demo to use sample payments.");
  const response = await fetch("/api/demo/workspace/action", { method: "POST", credentials: "same-origin", cache: "no-store", headers: demoRequestHeaders({ "Content-Type": "application/json" }, action === "reset" ? "owner" : undefined), body: JSON.stringify({ action, ...options }) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || "The demo action could not be completed.");
  if (result.fictional !== true || result.noBroadcast !== true) throw new Error("Unexpected demo response.");
  if(publish)window.dispatchEvent(new CustomEvent(DEMO_STATE_EVENT, { detail: result }));
  return result as DemoState;
}

export function DemoAction({ action, options, children, disabled = false, onComplete }: { action: DemoActionName; options?: Record<string, string>; children: ReactNode; disabled?: boolean; onComplete?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), locked = useRef(false);
  if (!isPublicDemo()) return null;
  return <div className="grid gap-2"><button type="button" aria-busy={busy} disabled={disabled || busy} className="inline-flex min-h-11 items-center justify-center gap-2 justify-self-start rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50" onClick={async () => { if (locked.current) return; locked.current = true; setBusy(true); setError(""); try { await demoAction(action, options); onComplete?.(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again."); } finally { locked.current = false; setBusy(false); } }}>{busy ? <LoaderCircle size={16} className="animate-spin"/> : <Play size={14}/>} {children}</button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>;
}
