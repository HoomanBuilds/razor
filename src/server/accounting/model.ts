import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../context";

export const providerSchema = z.enum(["quickbooks", "xero"]);
export type Provider = z.infer<typeof providerSchema>;
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const integer = z.string().regex(/^[1-9]\d{0,17}$/);
export const mappingInput = z.object({
 expectedVersion: z.number().int().nonnegative(), expenseAccountId: z.string().min(1).max(128), bankAccountId: z.string().min(1).max(128), taxCodeId: z.string().min(1).max(128),
 contacts: z.array(z.object({ recipientId: z.string().min(1).max(128), externalId: z.string().min(1).max(128) }).strict()).max(200),
 fxNumerator: integer, fxDenominator: integer, fxSource: z.string().trim().min(3).max(300), fxDate: z.iso.date(),
 closedThrough: z.iso.date().nullable(), acknowledgement: z.literal(true),
}).strict();
export type Mapping = z.infer<typeof mappingInput> & { functionalCurrency: string };
export interface Connection {
 id: string; organization_id: string; provider: Provider; created_by: string; status: string; environment: string;
 token_ciphertext: string | null; access_expires_at: string | null; refresh_owner: string | null; refresh_until: string | null;
 entities_ciphertext: string | null; entity_id: string | null; entity_name: string | null; currency: string | null; version: number;
 last_error: string | null; created_at: string; updated_at: string;
}
export interface Entity { id: string; name: string; connectionId?: string }
export interface CatalogItem { id: string; name: string; kind: "account" | "tax" | "contact"; type?: string; currency?: string; code?: string; zeroTax?: boolean; active: boolean }
export interface Job {
 id: string; organization_id: string; connection_id: string; entity_id: string; connection_version: number; mapping_version: number;
 kind: "bill" | "settlement"; source_id: string; source_hash: string; marker: string; payload_ciphertext: string; review_hash: string; state: string;
 created_by: string; approved_by: string | null; approved_at: string | null; write_started_at: string | null; attempts: number; lease_owner: string | null; lease_until: string | null;
 external_id: string | null; external_revision: string | null; provider_hash: string | null; last_error: string | null; created_at: string; updated_at: string;
}

export function functionalAmount(microUSDC: string, numerator: string, denominator: string) {
 if (!/^\d{1,31}$/.test(microUSDC) || !/^[1-9]\d{0,17}$/.test(numerator) || !/^[1-9]\d{0,17}$/.test(denominator)) throw new ApiError(422, "Use exact positive conversion terms", "ACCOUNTING_AMOUNT_INVALID");
 const scaled = BigInt(microUSDC) * BigInt(numerator) * 100n, divisor = 1_000_000n * BigInt(denominator);
 if (scaled % divisor) throw new ApiError(409, "The approved FX rate produces fractional functional-currency cents. Review a supported exact accounting amount; no rounding was applied", "ACCOUNTING_PRECISION_REQUIRED");
 const cents = scaled / divisor;
 if (cents <= 0n || cents > 99_999_999_999n) throw new ApiError(422, "This posting exceeds the supported accounting amount range", "ACCOUNTING_AMOUNT_INVALID");
 const text = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`, value = Number(text);
 if (Math.round(value * 100) !== Number(cents)) throw new ApiError(422, "The provider cannot represent this exact amount", "ACCOUNTING_PRECISION_REQUIRED");
 return { text, value, cents: cents.toString() };
}

export function postingPayload(provider: Provider, kind: "bill" | "settlement", input: { amount: number; date: string; marker: string; title: string; contactId: string; expenseAccountId: string; bankAccountId: string; taxCodeId: string; currency: string; externalBillId?: string; reference: string }) {
 if (provider === "quickbooks") return kind === "bill"
  ? { VendorRef: { value: input.contactId }, CurrencyRef: { value: input.currency }, TxnDate: input.date, DocNumber: input.marker, PrivateNote: input.reference, Line: [{ Amount: input.amount, Description: input.title, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: input.expenseAccountId }, TaxCodeRef: { value: input.taxCodeId } } }] }
  : { VendorRef: { value: input.contactId }, PayType: "Check", CheckPayment: { BankAccountRef: { value: input.bankAccountId } }, CurrencyRef: { value: input.currency }, TxnDate: input.date, DocNumber: input.marker, TotalAmt: input.amount, PrivateNote: input.reference, Line: [{ Amount: input.amount, LinkedTxn: [{ TxnId: input.externalBillId, TxnType: "Bill" }] }] };
 return kind === "bill"
  ? { Invoices: [{ Type: "ACCPAY", Contact: { ContactID: input.contactId }, Date: input.date, DueDate: input.date, InvoiceNumber: input.marker, Reference: input.reference, CurrencyCode: input.currency, Status: "DRAFT", LineAmountTypes: "Exclusive", LineItems: [{ Description: input.title, Quantity: 1, UnitAmount: input.amount, AccountCode: input.expenseAccountId, TaxType: input.taxCodeId }] }] }
  : { Payments: [{ Invoice: { InvoiceID: input.externalBillId }, Account: { AccountID: input.bankAccountId }, Date: input.date, Amount: input.amount, Reference: input.marker }] };
}
