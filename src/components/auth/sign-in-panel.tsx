"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ShieldCheck } from "lucide-react";
import { useIdentity } from "./identity-provider";
import { NewWalletSignIn } from "@/components/account/new-wallet-sign-in";
import { NetworkLogo, TokenLogo } from "@/components/assets/asset-identity";
import { RazorLogo, RazorMark } from "@/components/brand/razor-logo";
import { walletErrorMessage, type WalletFamily } from "./wallets";
import { localRedirect } from "@/lib/redirect-path";
import { withTaskDrawerWallet } from "@/components/workspace/task-drawer";
import "./sign-in.css";

const SocialSignIn = dynamic(() => import("./social-sign-in"), { ssr: false, loading: () => <div role="status" className="h-13 animate-pulse rounded-full bg-muted" aria-label="Loading secure sign-in"/> });
const WALLETS: Array<{ family: WalletFamily; label: string; network: string }> = [{ family: "near", label: "NEAR", network: "near" }, { family: "evm", label: "Ethereum / EVM", network: "eth" }, { family: "solana", label: "Solana", network: "sol" }];

export function WalletButtons({ link = false, onComplete }: { link?: boolean; onComplete?: () => Promise<void> }) {
  const { signInWallet } = useIdentity(), [pending, setPending] = useState<WalletFamily | null>(null), [error, setError] = useState<string | null>(null);
  async function connect(family: WalletFamily) {
    if (pending) return;
    setPending(family); setError(null);
    try { await withTaskDrawerWallet(() => signInWallet(family, link)); await onComplete?.(); } catch (error) { setError(walletErrorMessage(error)); } finally { setPending(null); }
  }
  return <div className="space-y-2.5">{WALLETS.map(({ family, label, network }) => <button key={family} type="button" disabled={pending !== null} aria-busy={pending === family} onClick={() => void connect(family)} className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-border bg-white px-4 py-3 text-left text-sm font-medium transition-colors hover:border-primary/25 hover:bg-secondary/40 disabled:opacity-50"><span className="flex min-w-0 items-center gap-3"><NetworkLogo network={network} size={22}/><span>{pending === family ? "Confirm in your wallet..." : `${link ? "Link" : "Continue with"} ${label}`}</span></span><ArrowUpRight size={16} className="shrink-0 text-muted-foreground group-hover:text-primary"/></button>)}{error && <p role="alert" className="rounded-xl bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}</div>;
}

function SignInStory() {
  return <section className="razor-auth-story" aria-label="Razor payment workspace"><a href="/" className="w-fit text-white"><RazorLogo size={27}/></a><div className="razor-auth-story-content"><span className="razor-auth-eyebrow"><span/>Company payments, connected</span><h2>Good business.<br/>Money in motion.</h2><p>One place for your people, your payments and everything in between.</p><div className="razor-auth-preview" aria-label="Illustration of Razor funding and payment preferences"><div className="razor-auth-preview-heading"><span className="flex items-center gap-2"><RazorMark size={17}/>Your payment workspace</span><span>Preview</span></div><div className="razor-auth-flow"><div><span className="razor-auth-flow-label">Fund in supported assets</span><div className="flex items-center gap-2"><TokenLogo symbol="ETH" size={32}/><TokenLogo symbol="SOL" size={32}/><TokenLogo symbol="USDC" size={32}/><span className="ml-1 text-xs text-white/65">Your choice</span></div></div><span className="razor-auth-flow-arrow" aria-hidden="true"><ArrowRight size={20}/></span><div className="razor-auth-near"><NetworkLogo network="near" size={24}/><span>NEAR</span></div></div><div className="razor-auth-checks"><span><Check size={14}/> Company approvals</span><span><Check size={14}/> Recipient preferences</span></div><div className="razor-auth-delivery"><span className="razor-auth-delivery-token"><TokenLogo symbol="USDC" size={29}/></span><div><span className="block text-sm font-medium">A route that works for them</span><span className="mt-1 block text-xs text-white/60">Preferred asset. Consented USDC backup.</span></div><ArrowUpRight size={18} className="ml-auto shrink-0 text-white/70"/></div></div></div><div className="razor-auth-story-footer"><span className="flex items-center gap-2"><NetworkLogo network="near" size={17}/>Built on NEAR</span><a href="/demo" className="inline-flex items-center gap-1.5">Explore the product<ArrowUpRight size={14}/></a></div></section>;
}

export function SignInPanel({ next = "/app", link = false }: { next?: string; link?: boolean }) {
  const { config, session, loading, error, refresh } = useIdentity(), router = useRouter();
  const destination = localRedirect(next, "/app");
  useEffect(() => { if (session && !link) router.replace(destination); }, [session, link, router, destination]);
  return <main className="razor-auth"><SignInStory/><section className="razor-auth-entry"><div className="flex items-center justify-between gap-4"><a href="/" className="text-primary lg:hidden"><RazorLogo size={24}/></a><a href="/" className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={13}/>Back to home</a></div><div className="razor-auth-form"><span className="mb-7 hidden w-fit rounded-2xl bg-secondary p-3 text-primary lg:block"><RazorMark size={28}/></span><h1>{link ? "Connect your account" : "Welcome to Razor"}</h1><p className="razor-auth-description">{link ? "Link a verified sign-in method to your existing account." : "Your company workspace and personal payments, together."}</p><div className="mt-8">{loading ? <div aria-live="polite" className="grid gap-3"><span className="h-13 animate-pulse rounded-full bg-muted"/><p className="text-center text-xs text-muted-foreground">Loading your sign-in options...</p></div> : <>{config?.socialEnabled && config.privyAppId && <><SocialSignIn appId={config.privyAppId} onComplete={refresh} link={link}/><div className="my-6 flex items-center gap-4 text-[11px] text-muted-foreground"><span className="h-px flex-1 bg-border"/>or use your wallet<span className="h-px flex-1 bg-border"/></div></>}<WalletButtons link={link}/>{!link && config?.ownerWalletSetup && <div className="mt-5 text-center"><NewWalletSignIn providers={config.ownerWalletSetup.providers} network={config.nearNetwork} onComplete={refresh}/></div>}{!config?.socialEnabled && <p className="mt-4 text-xs leading-5 text-muted-foreground">Google and email are unavailable right now. You can continue with your wallet.</p>}</>}{error && <p role="alert" className="mt-4 rounded-xl bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}</div><div className="mt-7 flex items-start gap-2.5 border-t border-border pt-5 text-xs leading-5 text-muted-foreground"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-primary"/><p>Sign-in gives account access. Payment approvals and wallet permissions are managed separately.</p></div></div><footer className="flex items-center justify-between gap-4 text-xs text-muted-foreground"><span>Global teams. Crypto payments.</span><a href="/help" className="inline-flex items-center gap-1 hover:text-foreground">Need a hand?<ArrowUpRight size={13}/></a></footer></section></main>;
}
