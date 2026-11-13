"use client";

import { createContext, useContext } from "react";
import type { Organization, Recipient, Section, Session } from "./types";
import type { BillingEntitlements } from "@/server/billing/types";

export interface WorkspaceContextValue {
  session: Session;
  organization: Organization;
  recipients: Recipient[];
  base: string;
  revision: number;
  billing?: BillingEntitlements | null;
  billingError?: string;
  refresh: () => void;
  navigate: (section: Section, paymentId?: string) => void;
  notify: (message: string) => void;
  invoiceReview: InvoiceReview | null;
  analyzeInvoice: (review: InvoiceReview | null) => void;
}

export interface InvoiceReview { id: string; recipientId: string; sourceFingerprint: string; reference: string; currency: string; text: string }

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Company workspace is required");
  return value;
}
