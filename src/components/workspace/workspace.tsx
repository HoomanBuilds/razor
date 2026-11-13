"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  Building2,
  CalendarDays,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  RefreshCw,
  Settings2,
  ShieldCheck,
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
import { WorkspaceContext, type InvoiceReview } from "./context";
import { InvoiceInbox } from "./invoice-inbox";
import { useAction, useResource } from "./hooks";
import { Action, control, Field, Panel } from "./shared";
import { Overview } from "./overview";
import { Bills, Payroll } from "./business";
import { BusinessClearing } from "./business-clearing";
import { Recipients } from "./recipients";
import { Payments } from "./payments";
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
import type { Organization, Recipient, Section } from "./types";

const navigation = [
  { id: "overview", title: "Overview", icon: LayoutDashboard },
  { id: "payments", title: "Payments", icon: Wallet },
  { id: "payroll", title: "Payroll", icon: CalendarDays },
  { id: "bills", title: "Bills", icon: ReceiptText },
  { id: "clearing", title: "Business clearing", icon: Building2 },
  { id: "recipients", title: "Payees", icon: Users },
  { id: "treasury", title: "Treasury", icon: Building2 },
  { id: "assistant", title: "Private assistant", icon: Sparkles },
  { id: "activity", title: "Activity & reports", icon: Activity },
  { id: "settings", title: "Company settings", icon: Settings2 },
] as const;

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
  const [creating, setCreating] = useState(false);
  const organization =
    session?.organizations.find((value) => value.id === organizationId) ??
    session?.organizations.find(
      (value) => value.id === session.activeOrganizationId,
    ) ??
    session?.organizations[0];
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("section");
    if (navigation.some((item) => item.id === value))
      setSection(value as Section);
  }, []);
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
        <SignInPanel />
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
          setCreating(false);
        }}
      />
    );
  const navigate = (next: Section) => {
    setSection(next);
    setSidebar(false);
    window.history.replaceState(null, "", `/?section=${next}`);
  };
  return (
    <div className="min-h-screen">
      <aside
        className={`${sidebar ? "flex" : "hidden"} fixed inset-y-0 left-0 z-40 w-64 flex-col border-r bg-card p-5 lg:flex`}
      >
        <div className="flex items-center justify-between">
          <a
            href="/"
            className="text-2xl font-black tracking-tight text-primary"
          >
            Razor
            <span className="ml-1 inline-block size-2 rounded-full bg-primary" />
          </a>
          <button
            onClick={() => setSidebar(false)}
            aria-label="Close navigation"
            className="lg:hidden"
          >
            <X size={20} />
          </button>
        </div>
        <div className="mt-8">
          <label
            htmlFor="company"
            className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Company workspace
          </label>
          <select
            id="company"
            className={`${control} mt-2 font-medium`}
            value={organization.id}
            onChange={async (event) => {
              const id = event.target.value;
              setOrganizationId(id);
              setSection("overview");
              try {
                await api(`/organizations/${id}/select`, {});
              } catch (cause) {
                setNotice(errorMessage(cause));
              }
            }}
          >
            {session.organizations.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs capitalize text-muted-foreground">
            {organization.role}
          </p>
          <a href="/receive" className="mt-3 block text-xs text-primary">
            My personal payments
          </a>
          <button
            className="mt-3 text-xs text-primary"
            onClick={() => setCreating(true)}
          >
            + Create another company
          </button>
        </div>
        <nav className="mt-7 grid gap-1">
          {navigation.map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${section === item.id ? "bg-secondary font-semibold text-primary" : "text-muted-foreground hover:bg-muted"}`}
            >
              <item.icon size={18} />
              {item.title}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-4 pt-8">
          <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            <ShieldCheck className="mb-2 text-primary" size={18} />
            NEAR company authority
            <br />
            <span className="mt-1 block">
              NEAR Intents cross-chain settlement
            </span>
          </div>
          <a href="/account" className="mb-3 block px-2 text-xs text-primary">Account and recovery</a>
          <button
            className="flex w-full items-center gap-2 px-2 text-xs text-muted-foreground"
            onClick={() =>
              void signOut().catch((cause) => setNotice(errorMessage(cause)))
            }
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      </aside>
      {sidebar && (
        <button
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          aria-label="Close navigation overlay"
          onClick={() => setSidebar(false)}
        />
      )}
      <div className="lg:ml-64">
        <header className="flex h-20 items-center justify-between gap-4 border-b bg-card px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <button
              className="lg:hidden"
              aria-label="Open navigation"
              onClick={() => setSidebar(true)}
            >
              <Menu size={22} />
            </button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {navigation.find((item) => item.id === section)?.title}
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {organization.name}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setRevision((value) => value + 1)}
              aria-label="Refresh workspace"
              className="rounded-md p-2 text-muted-foreground hover:bg-muted"
            >
              <RefreshCw size={17} />
            </button>
            <div className="hidden text-right text-xs sm:block">
              <p className="font-medium">
                {session.user.name || session.user.email || "Your account"}
              </p>
              <p className="mt-1 text-muted-foreground">Company payments</p>
            </div>
            <div className="grid size-9 place-items-center rounded-full bg-secondary text-sm font-semibold text-primary">
              {(session.user.name ||
                session.user.email ||
                "F")[0].toUpperCase()}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-screen-2xl p-5 sm:p-8">
          {notice && (
            <div
              role="status"
              className="mb-5 flex items-center justify-between gap-3 rounded-lg border bg-card p-4 text-sm"
            >
              {notice}
              <button onClick={() => setNotice("")} aria-label="Dismiss notice">
                <X size={16} />
              </button>
            </div>
          )}
          <CompanyWorkspace
            key={organization.id}
            session={session}
            organization={organization}
            section={section}
            revision={revision}
            refresh={() => setRevision((value) => value + 1)}
            navigate={navigate}
            notify={setNotice}
          />
        </main>
        <footer className="px-8 pb-6 text-xs text-muted-foreground">
          Status reflects confirmed evidence. Review held transfers before
          trying another payout.
        </footer>
      </div>
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
  navigate: (next: Section) => void;
  notify: (message: string) => void;
}) {
  const base = `/organizations/${organization.id}`;
  const [invoiceReview, setInvoiceReview] = useState<InvoiceReview | null>(
    null,
  );
  const { data, error } = useResource<{ recipients: Recipient[] }>(
    `${base}/recipients`,
    revision,
  );
  return (
    <WorkspaceContext.Provider
      value={{
        session,
        organization,
        base,
        recipients: data?.recipients ?? [],
        revision,
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
      {section === "overview" ? (
        <Overview />
      ) : section === "payments" ? (
        <div className="grid gap-6">
          <Payments />
          <PaymentManagementPanel mode="payments" />
          <OperationsPanel />
        </div>
      ) : section === "payroll" ? (
        <Payroll />
      ) : section === "bills" ? (
        <div className="grid gap-6">
          <InvoiceInbox />
          <Bills />
        </div>
      ) : section === "clearing" ? (
        <BusinessClearing />
      ) : section === "recipients" ? (
        <Recipients />
      ) : section === "treasury" ? (
        <div className="grid gap-6">
          <Treasury />
          <RetainedAssetsPanel />
          <FundingRefundsPanel />
          <ClientReservesPanel />
          <FundingRequestsPanel />
        </div>
      ) : section === "assistant" ? (
        <Assistant />
      ) : section === "activity" ? (
        <div className="grid gap-6"><ActivityLog /><ProjectReportsPanel /></div>
      ) : (
        <div className="grid gap-6"><CompanySettings /><TreasuryRecoveryPanel /><NotificationInbox /></div>
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
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5 py-12">
      <p className="mb-8 text-3xl font-black text-primary">Razor</p>
      <Panel
        title="Create your company"
        description="Start with payees, invoices and payroll. Connect your NEAR treasury when you are ready to fund payments."
      >
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void run("company", async () => {
              const result = await api<{ organization: Organization }>(
                "/organizations",
                { name: values.get("name"), timezone: values.get("timezone") },
              );
              await onCreated(result.organization.id);
            });
          }}
        >
          <a href="/receive" className="text-sm text-primary">
            Receiving payments? Open your personal workspace
          </a>
          <Field label="Company name">
            <input
              name="name"
              className={control}
              autoFocus
              required
              maxLength={120}
            />
          </Field>
          <Field label="Company time zone">
            <input
              name="timezone"
              className={control}
              required
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
            />
          </Field>
          <div className="rounded-lg bg-muted p-3 text-sm">
            Company amounts are recorded in <strong>USDC</strong>. Fund with any supported asset and choose supported payout assets for each payee.
          </div>
          <Action busy={busy === "company"}>Create workspace</Action>
          {onCancel && (
            <button
              type="button"
              className="text-sm text-primary"
              onClick={onCancel}
            >
              Back to company
            </button>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      </Panel>
    </main>
  );
}
