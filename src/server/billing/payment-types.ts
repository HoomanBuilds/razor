import type { BillingPlan, PurchaseTerms, SubscriptionState } from "./types";
import type { getEntitlements } from "./entitlements";
import type { WalletTransaction } from "../payments/types";

export interface BillingCheckoutSettings {
  ready: boolean;
  network: "mainnet" | "testnet";
  billingContract: string | null;
  tokenContract: string | null;
  issuerPublicKey: string | null;
  reason: string | null;
  code?: string;
  testnet: boolean;
}
export interface BillingOverview {
  canManage: true;
  plans: BillingPlan[];
  entitlements: ReturnType<typeof getEntitlements>;
  subscriptionState: SubscriptionState;
  checkout: BillingCheckoutSettings;
  payerAccounts: string[];
}
export interface BillingInvoice {
  id: string;
  organizationId: string;
  plan: BillingPlan;
  purchase: PurchaseTerms;
  amount: string;
  currency: "USDC";
  status: "prepared" | "claimed" | "submitted" | "paid" | "credit_required" | "refunded" | "expired" | "cancelled";
  network: "mainnet" | "testnet";
  billingContract: string;
  tokenContract: string;
  payerAccount: string;
  termsHash: string;
  quoteJson: string;
  signature: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  transactionHash: string | null;
  confirmedAt: string | null;
  refundedAmount: string;
  creditReason: string | null;
  refundRequest: { id: string; reason: string; amount: string; status: "requested" | "prepared" | "pending" | "completed" | "failed"; createdAt: string } | null;
}
export interface BillingInvoiceDetail {
  invoice: BillingInvoice;
  checkout: BillingCheckoutSettings;
  walletActions: WalletTransaction[];
  signerAccounts: string[];
  network: "mainnet" | "testnet";
  canSign: boolean;
  message: string;
}
export interface BillingInvoicePage { invoices: BillingInvoice[]; page: number; pageSize: number; total: number; hasMore: boolean }
