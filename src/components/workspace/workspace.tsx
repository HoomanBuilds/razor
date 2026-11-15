"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  Command,
  Plus,
  Search,
  Boxes,
  BookOpen,
  Building2,
  CalendarDays,
  CreditCard,
  Gift,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  MoreHorizontal,
  ReceiptText,
  RefreshCw,
  Settings2,
  Sparkles,
  Users,
  Wallet,
  X,
} from "lucide-react";
import {
  IdentityProvider,
  useIdentity,
} from "@/components/auth/identity-provider";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { api, errorMessage } from "@/lib/api";
import { canOpenSection, workspacePath, WORKSPACE_NAVIGATION_EVENT } from "@/lib/workspace-access";
import { WorkspaceContext, type InvoiceReview } from "./context";
import { InvoiceInbox } from "./invoice-inbox";
import { useAction, useResource } from "./hooks";
import { Action, control, Field, Panel } from "./shared";
import { Overview } from "./overview";
import { TimezonePicker } from "./timezone-picker";
import { RazorLogo, RazorMark } from "@/components/brand/razor-logo";
import { focusWorkspaceForm } from "./page-metrics";
import { FinanceInsightsPanel } from "./finance-insights";
import { NetworkLogo, TokenLogo } from "@/components/assets/asset-identity";
import { WorkspaceTabs } from "./workspace-tabs";
import { Bills, Payroll } from "./business";
import { BusinessClearing } from "./business-clearing";
import { Recipients } from "./recipients";
import { Payments } from "./payments";
import { Reconciliation } from "./reconciliation";
import { Treasury } from "./treasury";
import { FundingRequestsPanel } from "./funding-requests";
import { ClientReservesPanel } from "./client-reserves";
import { NotificationInbox } from "../notifications/inbox";
import { ProjectReportsPanel } from "./project-reports";
import { TreasuryRecoveryPanel } from "./treasury-recovery";
import { FundingRefundsPanel } from "./funding-refunds";
import { RetainedAssetsPanel } from "./retained-assets";
import { OperationsPanel } from "./operations";
import { PaymentManagementPanel } from "./payment-management";
import { CompanySettings, ActivityLog, Assistant } from "./settings";
import { Billing, BillingAccessNotice } from "./billing";
import { ExpensesPanel } from "./expenses";
import { ProcurementPanel } from "./procurement";
import { VendorCommitments } from "./vendor-commitments";
import { DistributionsPanel } from "./distributions";
import { CompanyPrivateProcessing } from "./company-private";
import { AccountingPanel } from "./accounting";
import { SupportPanel } from "./support";
import { CompanyInsightsPanel } from "./company-insights";
import { WorkflowFeedback, WorkflowFeedbackSummary } from "./workflow-feedback";
import { CompanyPrivateAgreements } from "../private-agreements/panels";
import { WorkingCapitalPanel } from "./financing";
import { EvidenceSharesPanel } from "@/components/evidence-sharing/management";
import type { BillingEntitlements } from "@/server/billing/types";
import type { Organization, Recipient, Section } from "./types";

const navigation = [
  { id: "overview", title: "Dashboard", icon: LayoutDashboard },
  { id: "payments", title: "Payments", icon: Wallet },
  { id: "payroll", title: "Payroll", icon: CalendarDays },
  { id: "bills", title: "Bills", icon: ReceiptText },
  { id: "expenses", title: "Expenses", icon: CreditCard },
  { id: "procurement", title: "Purchasing", icon: Boxes },
  { id: "distributions", title: "Distributions", icon: Gift },
  { id: "clearing", title: "Business clearing", icon: Building2 },
  { id: "recipients", title: "Payees", icon: Users },
  { id: "treasury", title: "Treasury", icon: Building2 },
  { id: "financing", title: "Working capital", icon: CreditCard },
  { id: "assistant", title: "Private assistant", icon: Sparkles },
  { id: "activity", title: "Activity & reports", icon: Activity },
  { id: "accounting", title: "Accounting", icon: BookOpen },
  { id: "billing", title: "Billing & plans", icon: CreditCard },
  { id: "settings", title: "Company settings", icon: Settings2 },
  { id: "support", title: "Help & support", icon: LifeBuoy },
] as const;


const navigationGroups = [
  { title: "Workspace", sections: ["overview", "payments", "treasury", "payroll", "bills", "recipients"] },
  { title: "Operations", sections: ["expenses", "procurement", "distributions", "clearing", "financing"] },
  { title: "Insights", sections: ["assistant", "activity", "accounting"] },
  { title: "Company", sections: ["billing", "settings", "support"] },
];

const shortNavigationTitles: Partial<Record<Section,string>> = { clearing: "Clearing", financing: "Financing", assistant: "AI assistant", activity: "Activity", billing: "Billing", settings: "Settings", support: "Support" };

const descriptions: Record<Section, string> = {
  overview: "Your money, payments and next steps. All in one place.",
  payments: "Prepare, approve and track every company payment.",
  treasury: "",
  payroll: "Pay your team, on their terms.",
  bills: "Keep supplier invoices and payments in sync.",
  recipients: "One place for your employees, contractors and suppliers.",
  expenses: "Give every business expense a clear path to reimbursement.",
  procurement: "Manage purchases, agreements and supplier commitments.",
  distributions: "Create and manage claimable USDC distributions.",
  clearing: "Settle what companies owe each other with less movement of funds.",
  financing: "Manage invoice financing and working capital.",
  assistant: "Make sense of your finances with private intelligence.",
  activity: "Follow your company's payment activity and financial records.",
  accounting: "Keep payment records ready for your books.",
  billing: "Your plan, usage and subscription payments.",
  settings: "Manage company preferences, access and recovery.",
  support: "Find answers and get help with your workspace.",
};

export function WorkspaceApp() {
  return (
    <IdentityProvider>
      <Workspace />
    </IdentityProvider>
  );
}

function Workspace() {
  const {
    session,
    loading,
    error,
    refresh: refreshIdentity,
    signOut,
  } = useIdentity();
  const [organizationId, setOrganizationId] = useState("");
  const [section, setSection] = useState<Section>("overview");
  const [revision, setRevision] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [notice, setNotice] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const searchDialog = useRef<HTMLDialogElement>(null);
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchingLock = useRef(false);
  const activeScope = useRef("");
  const organization =
    session?.organizations.find((value) => value.id === organizationId) ??
    session?.organizations.find(
      (value) => value.id === session.activeOrganizationId,
    ) ??
    session?.organizations[0];
  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search), value = params.get("section");
      setOrganizationId(params.get("company") ?? "");
      setSection(navigation.some(item => item.id === value) ? value as Section : "overview");
      setSidebar(false);
      setNotice("");
    };
    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, []);
  const visibleSection = organization && canOpenSection(section, organization.permissions) ? section : "overview";
  const scope = session && organization ? `${session.user.id}:${organization.id}:${organization.permissions.join(",")}` : "";
  activeScope.current = scope;
  useEffect(() => {
    if (!organization) return;
    const params = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", workspacePath(organization.id, visibleSection, params.get("payment") ?? undefined, params.get("invoice") ?? undefined));
  }, [organization?.id, visibleSection]);
  useEffect(() => {
    if (!sidebar || !scope) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const mobile = window.matchMedia("(max-width: 1023px)").matches;
    const navigation = document.getElementById("company-navigation");
    if (!navigation) return;
    const previousOverflow = document.body.style.overflow;
    const focusable = () => Array.from(navigation?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []);
    if (mobile) {
      document.body.style.overflow = "hidden";
      focusable()[0]?.focus();
    }
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSidebar(false); return; }
      if (!mobile || event.key !== "Tab") return;
      const items = focusable(), first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      if (mobile) {
        document.body.style.overflow = previousOverflow;
        if (previous?.isConnected) previous.focus();
      }
    };
  }, [sidebar, scope]);
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if (!document.getElementById("company-navigation")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(value => !value);
      }
    };
    window.addEventListener("keydown", search);
    return () => window.removeEventListener("keydown", search);
  }, []);
  useEffect(() => {
    const dialog = searchDialog.current;
    if (!scope) {
      dialog?.close();
      setSearchOpen(false);
      setSidebar(false);
      return;
    }
    if (!dialog) return;
    if (searchOpen && !dialog.open) dialog.showModal();
    else if (!searchOpen && dialog.open) dialog.close();
  }, [searchOpen, scope]);
  if (loading)
    return (
      <main className="grid min-h-screen place-items-center">
        <p className="text-sm text-muted-foreground">
          Opening your workspace...
        </p>
      </main>
    );
  if (!session)
    return (
      <div>
        {error && (
          <p role="alert" className="p-4 text-center text-sm text-destructive">
            {error}
          </p>
        )}
        <SignInPanel next={typeof window === "undefined" ? "/" : window.location.pathname + window.location.search} />
      </div>
    );
  if (!organization && !creating && session.recipientProfileCount)
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5 py-12">
        <Panel
          title="Your personal payments"
          description="Review your pay, invoices and receiving preferences across the companies that pay you."
        >
          <a
            href="/receive"
            className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Open my payments
          </a>
          <button
            className="mt-5 block text-sm text-primary"
            onClick={() => setCreating(true)}
          >
            Create a company workspace
          </button>
        </Panel>
      </main>
    );
  if (!organization || creating)
    return (
      <CreateCompany
        onCancel={organization ? () => setCreating(false) : undefined}
        onCreated={async (id) => {
          await refreshIdentity();
          setOrganizationId(id);
          setSection("overview");
          window.history.pushState(null, "", workspacePath(id, "overview"));
          setCreating(false);
        }}
      />
    );
  const navigate = (next: Section, paymentId?: string) => {
    if (activeScope.current !== scope || !canOpenSection(next, organization.permissions)) return;
    setSection(next);
    setSidebar(false);
    window.history.pushState(null, "", workspacePath(organization.id, next, paymentId));
    window.dispatchEvent(new Event(WORKSPACE_NAVIGATION_EVENT));
  };
  const currentTitle = visibleSection === "assistant" && !organization.permissions.includes("documents:manage") ? "Finance insights" : navigation.find(item => item.id === visibleSection)?.title;
  const allowedNavigation = navigation.filter(item => canOpenSection(item.id, organization.permissions));
  const primaryIds = ["overview", "payments", "payroll", "bills", "recipients", "treasury", "activity"];
  const primaryNavigation = primaryIds.flatMap(id => allowedNavigation.filter(item => item.id === id));
  const compactNavigation = [...primaryNavigation];
  const advanced = allowedNavigation.find(item => item.id === visibleSection && !compactNavigation.some(primary => primary.id === item.id));
  if (advanced) compactNavigation.push(advanced);
  const navigationButton = (item: (typeof navigation)[number]) => <button type="button" key={item.id} title={item.title} onClick={() => navigate(item.id)} aria-current={visibleSection === item.id ? "page" : undefined} aria-label={shortNavigationTitles[item.id] ?? item.title} className={`group flex min-h-10 items-center rounded-xl text-left text-[13px] transition-colors ${sidebar ? "gap-3 px-3" : "justify-center lg:mx-auto lg:size-11 lg:w-11"} ${visibleSection === item.id ? "bg-secondary font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                <item.icon size={19} strokeWidth={visibleSection === item.id ? 2 : 1.7} className="shrink-0" aria-hidden="true"/>
                <span className={sidebar ? "" : "lg:sr-only"}>{item.id === "assistant" && !organization.permissions.includes("documents:manage") ? "Finance insights" : shortNavigationTitles[item.id] ?? item.title}</span>
              </button>;
  const matches = allowedNavigation.filter(item => `${item.title} ${descriptions[item.id]}`.toLowerCase().includes(searchTerm.toLowerCase().trim()));
  const userName = session.user.name || session.user.email || "Your account";
  const accountHref = `/account?returnTo=${encodeURIComponent(typeof window === "undefined" ? "/app" : window.location.pathname + window.location.search)}`;
  return (
    <div className="workspace-surface min-h-screen">
      <aside id="company-navigation" aria-label="Company navigation" data-expanded={sidebar} className={`dashboard-dock ${sidebar ? "flex w-64" : "hidden w-[84px]"} fixed inset-y-0 left-0 z-40 flex-col border-r border-border/60 bg-white p-3 lg:flex`}>
        <div className={`flex h-14 shrink-0 items-center ${sidebar ? "justify-between px-2" : "justify-center"}`}>
          <a href="/app" aria-label="Razor workspace" className="flex items-center gap-3 font-semibold tracking-tight">
            <RazorMark size={31} className="shrink-0 text-[#5c5e68]"/>
            <span className={`${sidebar ? "" : "lg:hidden"} text-2xl`}>Razor</span>
          </a>
          {sidebar && <button onClick={() => setSidebar(false)} aria-label="Collapse navigation" className="rounded-full p-2 text-muted-foreground hover:bg-muted"><X size={17}/></button>}
        </div>
        <div className={`${sidebar ? "" : "lg:hidden"} mt-3`}>
          <label htmlFor="company" className="sr-only">Company workspace</label>
          <select
            id="company"
            className={`${control} text-xs font-medium`}
            value={organization.id}
            disabled={switching}
            onChange={async (event) => {
              if (switchingLock.current) return;
              const id = event.target.value;
              if (id === "__new_company__") { setCreating(true); setSidebar(false); return; }
              switchingLock.current = true;
              setSwitching(true);
              try {
                await api(`/organizations/${id}/select`, {});
                setOrganizationId(id);
                setSection("overview");
                setNotice("");
                setSidebar(false);
                window.history.pushState(null, "", workspacePath(id, "overview"));
                await refreshIdentity();
              } catch (cause) {
                setNotice(errorMessage(cause));
              } finally {
                switchingLock.current = false;
                setSwitching(false);
              }
            }}
          >
            {session.organizations.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
            <option value="__new_company__">+ Create another company</option>
          </select>
        </div>
        {!sidebar && <button data-dock-company type="button" className="mt-4 hidden size-11 shrink-0 self-center place-items-center rounded-xl bg-muted text-sm font-medium lg:grid" title={`${organization.name}: switch company`} aria-label={`Switch company from ${organization.name}`} onClick={() => setSidebar(true)}>{organization.name.slice(0,2).toUpperCase()}</button>}
        <nav aria-label="Workspace sections" className="dashboard-dock-nav dashboard-nav-scroll mt-5 min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pb-4 [scrollbar-width:thin]">
          {sidebar ? <div className="grid gap-4"><div className="grid gap-1">{primaryNavigation.map(navigationButton)}</div>{navigationGroups.map(group => {
            const items = allowedNavigation.filter(item => group.sections.includes(item.id) && !primaryIds.includes(item.id));
            if (!items.length) return null;
            return <details key={group.title} className="workspace-nav-group" open={items.some(item => item.id === visibleSection)}><summary className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-white/50"><span>{group.title === "Company" ? "Workspace tools" : group.title === "Insights" ? "Finance & insights" : group.title}</span><ChevronRight size={13} className="workspace-nav-chevron transition-transform"/></summary><div className="mt-1 grid gap-1">{items.map(navigationButton)}</div></details>;
          })}</div> : <div className="grid gap-1">{compactNavigation.map(navigationButton)}<button type="button" title="All workspace tools" aria-label="All workspace tools" className="mx-auto mt-1 grid size-11 place-items-center rounded-xl text-muted-foreground hover:bg-white" onClick={() => { setSidebar(true); requestAnimationFrame(() => document.querySelector<HTMLElement>('#company-navigation [aria-current="page"]')?.focus()); }}><MoreHorizontal size={21}/><span className="sr-only">All workspace tools</span></button></div>}
        </nav>
        <div className={`dashboard-account-dock shrink-0 space-y-2 border-t border-border/60 pt-3 ${sidebar ? "px-2" : "flex flex-col items-center"}`}>
          <a href="/receive" title="My personal payments" aria-label="My personal payments" className={`flex min-h-10 items-center gap-3 rounded-xl text-xs text-muted-foreground hover:bg-muted ${sidebar ? "px-2" : "size-10 justify-center"}`}><Wallet size={18}/><span className={sidebar ? "" : "lg:sr-only"}>My personal payments</span></a>
          <a href={accountHref} title="Account and recovery" aria-label="Account and recovery" className={`flex items-center gap-3 rounded-xl text-xs ${sidebar ? "p-2" : "justify-center"}`}><span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-sm font-medium text-white">{userName[0].toUpperCase()}</span><span className={sidebar ? "min-w-0 truncate" : "lg:sr-only"}>{userName}</span></a>
          <button title="Sign out" aria-label="Sign out" className={`flex min-h-10 items-center gap-3 rounded-xl text-xs text-muted-foreground hover:bg-muted ${sidebar ? "w-full px-2" : "size-10 justify-center"}`} onClick={() => void signOut().catch(cause => setNotice(errorMessage(cause)))}><LogOut size={17}/><span className={sidebar ? "" : "lg:sr-only"}>Sign out</span></button>
        </div>
      </aside>
      {sidebar && <button className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[2px] lg:hidden" aria-label="Close navigation overlay" onClick={() => setSidebar(false)}/>}
      <div className={`min-w-0 ${sidebar ? "lg:ml-64" : "lg:ml-[84px]"}`}>
        <header className="dashboard-canvas flex min-h-18 items-center justify-between gap-3 px-5 sm:px-8 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <button className="rounded-full p-2 text-muted-foreground hover:bg-muted" aria-label={sidebar ? "Collapse navigation" : "Expand navigation"} aria-expanded={sidebar} aria-controls="company-navigation" onClick={() => setSidebar(value => !value)}><Menu size={19}/></button>
            <button type="button" onClick={() => setSidebar(true)} className="max-w-48 truncate text-sm font-medium" title="Switch company">{organization.name}</button>
            <ChevronRight size={13} className="hidden shrink-0 text-muted-foreground sm:block"/>
            <span className="hidden truncate text-sm text-muted-foreground sm:block">{currentTitle}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => { setSearchTerm(""); setSearchOpen(true); }} aria-label="Search workspace pages" className="flex h-10 items-center gap-3 rounded-full bg-muted px-3 text-sm text-muted-foreground hover:bg-secondary"><Search size={17}/><span className="hidden md:block">Find a page</span><kbd className="hidden items-center gap-0.5 rounded border border-border bg-white px-1.5 py-0.5 text-[10px] md:flex"><Command size={10}/>K</kbd></button>
            <button onClick={() => void refreshIdentity().then(() => setRevision(value => value + 1)).catch(cause => setNotice(errorMessage(cause)))} aria-label="Refresh workspace" title="Refresh workspace" className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground hover:bg-secondary"><RefreshCw size={16}/></button>
            <a href={accountHref} aria-label="Open account settings" className="ml-1 grid size-9 place-items-center rounded-full bg-secondary text-sm font-medium text-primary">{userName[0].toUpperCase()}</a>
          </div>
        </header>
        <main className="dashboard-canvas mx-auto max-w-[1480px] px-5 pb-8 pt-5 sm:px-6 sm:pt-6 lg:px-6">
          <div className="dashboard-page-heading mb-7 flex flex-wrap items-start justify-between gap-4">
            <div><div className="flex flex-wrap items-center gap-3"><h1 className="text-[30px] font-medium leading-tight tracking-[-.04em] sm:text-4xl">{currentTitle}</h1>{organization.near_network && <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground"><NetworkLogo network="near" size={14}/>NEAR {organization.near_network}</span>}</div>{visibleSection !== "overview" && visibleSection !== "payroll" && visibleSection !== "bills" && visibleSection !== "procurement" && visibleSection !== "recipients" && <p className="mt-2 text-sm leading-6 text-muted-foreground">{descriptions[visibleSection]}</p>}</div>
            {visibleSection === "overview" && organization.permissions.includes("payments:prepare") && organization.permissions.includes("recipients:read") && <button className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-white transition-colors hover:bg-primary/90" onClick={() => { navigate("payments"); focusWorkspaceForm("payment-compose"); }}><Plus size={17}/>New payment</button>}
          </div>
          {notice && <div role="status" className="mb-6 flex items-center justify-between gap-3 rounded-2xl border bg-muted p-4 text-sm">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice" className="rounded-full p-1 hover:bg-white"><X size={16}/></button></div>}
          <div className="workspace-content"><CompanyWorkspace key={scope} session={session} organization={organization} section={visibleSection} revision={revision} refresh={() => { if (activeScope.current === scope) setRevision(value => value + 1); }} navigate={navigate} notify={message => { if (activeScope.current === scope) setNotice(message); }}/></div>
        </main>
      </div>
      <dialog ref={searchDialog} aria-labelledby="workspace-search-title" onCancel={() => setSearchOpen(false)} onClose={() => setSearchOpen(false)} onClick={event => { if (event.target === event.currentTarget) setSearchOpen(false); }} className="fixed inset-x-0 top-[16vh] m-auto max-h-[65vh] w-[calc(100%_-_2rem)] max-w-lg overflow-hidden rounded-3xl border border-border bg-white p-0 shadow-xl backdrop:bg-black/20 backdrop:backdrop-blur-sm">
        <div className="flex items-center gap-3 border-b px-5 py-4"><Search size={19} className="shrink-0 text-muted-foreground"/><label id="workspace-search-title" htmlFor="workspace-page-search" className="sr-only">Find a workspace page</label><input id="workspace-page-search" autoFocus value={searchTerm} onChange={event => setSearchTerm(event.target.value)} placeholder="Where would you like to go?" className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"/><button aria-label="Close page search" onClick={() => setSearchOpen(false)} className="rounded-full p-1 text-muted-foreground hover:bg-muted"><X size={17}/></button></div>
        <div className="max-h-[48vh] overflow-y-auto p-2">{matches.length ? matches.map(item => <button key={item.id} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-muted" onClick={() => { navigate(item.id); setSearchOpen(false); }}><item.icon size={18} className="shrink-0 text-primary"/><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{item.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{descriptions[item.id]}</span></span><ArrowUpRight size={15} className="shrink-0 text-muted-foreground"/></button>) : <p className="px-4 py-8 text-center text-sm text-muted-foreground">No matching pages. Try payments, payroll or treasury.</p>}</div>
      </dialog>
    </div>
  );
}

function CompanyWorkspace({
  session,
  organization,
  section,
  revision,
  refresh,
  navigate,
  notify,
}: {
  session: NonNullable<ReturnType<typeof useIdentity>["session"]>;
  organization: Organization;
  section: Section;
  revision: number;
  refresh: () => void;
  navigate: (next: Section, paymentId?: string) => void;
  notify: (message: string) => void;
}) {
  const base = `/organizations/${organization.id}`;
  const [invoiceReview, setInvoiceReview] = useState<InvoiceReview | null>(
    null,
  );
  const { data, error, loading: recipientsLoading } = useResource<{ recipients: Recipient[] }>(
    organization.permissions?.includes("recipients:read") ? `${base}/recipients` : null,
    revision,
  );
  const billing = useResource<BillingEntitlements>(`${base}/billing/entitlements`, revision);
  return (
    <WorkspaceContext.Provider
      value={{
        session,
        organization,
        base,
        recipients: data?.recipients ?? [],
        recipientsLoading,
        recipientsError: error,
        revision,
        billing: billing.data,
        billingError: billing.error,
        refresh,
        navigate,
        notify,
        invoiceReview,
        analyzeInvoice: (review) => {
          setInvoiceReview(review);
          navigate("assistant");
        },
      }}
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-amber-900">
          Payee directory: {error}
        </p>
      )}
      <BillingAccessNotice section={section} />
      {section === "overview" ? (
        <Overview />
      ) : section === "payments" ? (
        <WorkspaceTabs key={section} tabs={[
          { label: "Payment queue", content: <Payments /> },
          { label: "Reconciliation", content: <Reconciliation /> },
          { label: "Payment tools", content: <PaymentManagementPanel mode="payments" /> },
          { label: "Operations", content: <OperationsPanel /> },
        ]} />
      ) : section === "payroll" ? (
        <Payroll />
      ) : section === "expenses" ? (
        <ExpensesPanel />
      ) : section === "distributions" ? (
        <DistributionsPanel />
      ) : section === "accounting" ? (
        <AccountingPanel key={section}/>
      ) : section === "support" ? (
        <div className="grid gap-6"><SupportPanel /><WorkflowFeedback /></div>
      ) : section === "procurement" ? (
        <WorkspaceTabs key={section} tabs={[{ label: "Purchases", content: <ProcurementPanel /> }, { label: "Private agreements", content: <CompanyPrivateAgreements /> }, { label: "Commitments", content: <div id="vendor-commitments"><VendorCommitments /></div> }]} />
      ) : section === "bills" ? (
        <WorkspaceTabs key={section} tabs={[{ label: "Bills", content: <Bills /> }, { label: "Invoice inbox", content: <InvoiceInbox /> }]} />
      ) : section === "clearing" ? (
        <BusinessClearing />
      ) : section === "recipients" ? (
        <Recipients />
      ) : section === "treasury" ? (
        <WorkspaceTabs key={section} tabs={[
          { label: "Funds", content: <Treasury /> },
          { label: "Retained assets", content: <RetainedAssetsPanel /> },
          { label: "Refunds", content: <FundingRefundsPanel /> },
          { label: "Client reserves", content: <ClientReservesPanel /> },
          { label: "Funding requests", content: <FundingRequestsPanel /> },
        ]} />
      ) : section === "financing" ? (
        <WorkingCapitalPanel />
      ) : section === "assistant" ? (
        organization.permissions?.includes("documents:manage") ? <WorkspaceTabs key={section} tabs={[
          { label: "Invoice analysis", content: <Assistant /> },
          { label: "Finance insights", content: <FinanceInsightsPanel /> },
          { label: "Private processing", content: <CompanyPrivateProcessing /> },
        ]} /> : <Assistant />
      ) : section === "activity" ? (
        <WorkspaceTabs key={section} tabs={[{ label: "Activity log", content: <ActivityLog /> }, { label: "Financial analytics", content: <CompanyInsightsPanel /> }, { label: "Project reports", content: <ProjectReportsPanel /> }, { label: "Evidence sharing", content: <EvidenceSharesPanel /> }, { label: "Workflow feedback", content: <WorkflowFeedbackSummary /> }]} />
      ) : section === "billing" ? (
        <Billing />
      ) : (
        <WorkspaceTabs key={section} tabs={[
          { label: "Profile", content: <CompanySettings /> },
          { label: "Wallets", content: <CompanySettings view="wallets" /> },
          ...(organization.permissions?.includes("company:manage") ? [
            { label: "Policies", content: <CompanySettings view="policies" /> },
            { label: "Team access", content: <CompanySettings view="team" /> },
            { label: "Integrations", content: <CompanySettings view="integrations" /> },
          ] : []),
          { label: "Treasury recovery", content: <TreasuryRecoveryPanel /> },
          { label: "Notifications", content: <NotificationInbox /> },
        ]} />
      )}
    </WorkspaceContext.Provider>
  );
}

function CreateCompany({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { busy, error, run } = useAction();
  return <main className="razor-onboarding flex min-h-screen items-center justify-center bg-white px-5 py-10 sm:px-8">
    <section className="w-full max-w-4xl" aria-labelledby="create-company-title">
      <div className="mb-8 flex items-center justify-between gap-4"><a href="/" aria-label="Razor home"><RazorLogo size={30}/></a>{onCancel && <button type="button" disabled={!!busy} className="rounded-full bg-muted px-4 py-2 text-xs text-muted-foreground hover:bg-secondary" onClick={onCancel}>Back to workspace</button>}</div>
      <div className="grid overflow-hidden rounded-[28px] border border-border bg-muted/50 lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]">
        <div className="flex min-w-0 flex-col p-7 sm:p-9"><p className="text-xs font-medium text-primary">Your company workspace</p><h1 id="create-company-title" className="mt-4 max-w-xs text-[32px] font-medium leading-tight tracking-[-.04em] sm:text-4xl">Create your company</h1><p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">A workspace for your team, invoices and payments.</p><div className="mt-8 hidden items-start gap-3 rounded-2xl bg-white p-4 text-xs leading-5 lg:flex"><Wallet size={17} className="mt-0.5 shrink-0 text-primary"/><span>Start with payees and payment drafts. Connect your treasury when you're ready to add funds.</span></div><p className="mt-5 hidden text-xs leading-5 text-muted-foreground lg:mt-auto lg:block lg:pt-8">Just receiving payments? <a href="/receive" className="font-medium text-primary underline underline-offset-4">Open my payments</a></p></div>
        <div className="border-t border-border bg-white p-7 sm:p-9 lg:border-l lg:border-t-0"><h2 className="hidden text-xl font-medium tracking-tight lg:block">Company details</h2><form className="grid gap-5 lg:mt-6" onSubmit={event => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void run("company", async () => {
            const result = await api<{ organization: Organization }>("/organizations", { name: values.get("name"), timezone: values.get("timezone") });
            await onCreated(result.organization.id);
          });
        }}><Field label="Company name"><input name="name" className={control} autoFocus autoComplete="organization" required maxLength={120} placeholder="Your company or team" disabled={!!busy}/></Field><Field label="Time zone" hint="Used for payroll dates and payment schedules."><TimezonePicker disabled={!!busy}/></Field><div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2.5 text-xs text-muted-foreground"><TokenLogo symbol="USDC" size={18}/><span>Amounts are recorded in USDC. Fund with supported assets.</span></div>{error && <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}<Action busy={busy === "company"} disabled={!!busy} className="min-h-12 w-full">Create company workspace<ArrowUpRight size={16}/></Action></form><p className="mt-5 text-xs text-muted-foreground lg:hidden">Just receiving payments? <a href="/receive" className="font-medium text-primary underline underline-offset-4">Open my payments</a></p></div>
      </div>
    </section>
  </main>;
}
