import { z } from "zod";

export const integrationScopes = ["payments:read", "payments:draft", "invoices:read", "invoices:draft", "recipients:read", "recipients:draft", "evidence:read", "funding:read", "payroll:read"] as const;
export type IntegrationScope = typeof integrationScopes[number];
export const scopePermissions: Record<IntegrationScope, string[]> = {
  "payments:read": ["payments:read"],
  "payments:draft": ["payments:prepare", "payments:read", "recipients:read"],
  "invoices:read": ["payments:read", "recipients:read"],
  "invoices:draft": ["payments:prepare", "payments:read", "recipients:read"],
  "recipients:read": ["recipients:read"],
  "recipients:draft": ["recipients:manage", "recipients:read"],
  "evidence:read": ["payments:read"],
  "funding:read": ["payments:read"],
  "payroll:read": ["payments:read", "recipients:read"],
};
export const credentialInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  principalUserId: z.string().min(1).max(128),
  scopes: z.array(z.enum(integrationScopes)).min(1).max(integrationScopes.length).transform(values => [...new Set(values)]),
  expiresAt: z.iso.datetime(),
});
export const pageInput = z.strictObject({
  after: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const atomic = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);
export const paymentDraftInput = z.strictObject({
  recipientId: z.string().min(1).max(128),
  reference: z.string().trim().min(1).max(120),
  amount: atomic.refine(value => /^(0|[1-9][0-9]{0,38})$/.test(value) && BigInt(value) > 0n && BigInt(value) <= (1n << 128n) - 1n),
  maxFee: atomic.default("0"),
  scheduledFor: z.iso.datetime().optional(),
});
export const invoiceDraftInput = paymentDraftInput.omit({ scheduledFor: true }).extend({
  title: z.string().trim().min(1).max(240),
  dueDate: z.iso.datetime().optional(),
});
export const recipientDraftInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254).optional(),
  kind: z.enum(["employee", "contractor", "business"]),
  primaryNetwork: z.enum(["near", "eth", "base", "arb", "op", "pol", "sol"]),
  primaryAddress: z.string().trim().min(2).max(200),
});
export const idempotencyInput = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
export type DraftKind = "payment" | "invoice" | "recipient";
export const draftSchemas = { payment: paymentDraftInput, invoice: invoiceDraftInput, recipient: recipientDraftInput };

const identifier = z.string();
const time = z.string();
export const draftReceiptOutput = z.strictObject({ requestId: identifier, kind: z.enum(["payment", "invoice", "recipient"]), resourceId: identifier, createdAt: time, replayed: z.boolean() });
export const resourceOutputs = {
  payment: z.strictObject({ creditRetirement:z.strictObject({noteId:identifier,billId:identifier,retiredAmount:z.string()}).nullable(), id: identifier, recipientId: identifier, reference: z.string(), amount: z.string(), maxFee: z.string(), status: z.string(), deliveredAmount: z.string(), fundedDischarge: z.strictObject({ roundId: identifier, amount: z.string(), mode: z.literal("cash_backed_native_v1") }).nullable(), scheduledFor: time.nullable(), createdAt: time, updatedAt: time }),
  invoice: z.strictObject({ id: identifier, recipientId: identifier, reference: z.string(), title: z.string(), amount: z.string(), maxFee: z.string(), dueDate: time.nullable(), status: z.string(), paymentId: identifier.nullable(), deliveredAmount: z.string(), setoffAmount: z.string(), fundedClearingAmount: z.string(), acceptedCreditAmount:z.string(), remainingLiability: z.string(), createdAt: time, updatedAt: time }),
  recipient: z.strictObject({ id: identifier, name: z.string(), kind: z.string(), status: z.string(), version: z.number().int(), createdAt: time, updatedAt: time }),
};
export const requestStatusOutput = draftReceiptOutput.omit({ replayed: true }).extend({ status: z.string(), updatedAt: time });
export const fundingOutput = z.strictObject({ id: identifier, paymentId: identifier.nullable(), status: z.string(), creditedAmount: z.string(), createdAt: time, updatedAt: time });
export const payrollOutput = z.strictObject({ id: identifier, reference: z.string(), status: z.string(), periodStart: z.string(), periodEnd: z.string(), createdAt: time, updatedAt: time });
export const attemptsOutput = z.strictObject({ attempts: z.array(z.strictObject({ id: identifier, route: z.string(), state: z.string(), createdAt: time, updatedAt: time })) });
export const evidenceOutput = z.strictObject({ evidence: z.array(z.strictObject({ id: identifier, kind: z.string(), contentHash: z.string(), receipt: z.string().nullable(), retained: z.boolean(), createdAt: time, expiresAt: time })) });
export const integrationOutputSchemas = { draftReceipt: draftReceiptOutput, requestStatus: requestStatusOutput, funding: fundingOutput, payroll: payrollOutput, attempts: attemptsOutput, evidence: evidenceOutput,
  ...Object.fromEntries<z.ZodType>(Object.entries(resourceOutputs).flatMap(([kind, schema]) => [[kind, schema] as const, [`${kind}Page`, z.strictObject({ items: z.array(schema), nextCursor: identifier.nullable() })] as const])) };
