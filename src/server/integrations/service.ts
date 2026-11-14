import { reserveOptionalCreation } from "../billing/capabilities";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { encrypt, decrypt, hashToken, newToken } from "../identity/crypto";
import { getAccess, audit } from "../identity/session";
import { getRecipient, saveVersion } from "../identity/recipients";
import { normalizeDestination } from "../../lib/recipient-destination";
import { createPayment, getPayment } from "../payments/service";
import { createBill, getPayrollRun } from "../business/service";
import { getBillTerms } from "../business/bill-terms";
import { listPrivateEvidence } from "../reconciliation/evidence";
import { credentialInput, draftSchemas, idempotencyInput, pageInput, scopePermissions, type DraftKind, type IntegrationScope } from "./schemas";
import { enqueueIntegrationEvent } from "./webhooks";

const now = () => new Date().toISOString();
interface Credential {
  id: string; organization_id: string; principal_user_id: string; name: string; token_hash: string;
  token_prefix: string; scopes_json: string; expires_at: string; revoked_at: string | null;
  created_at: string; rotated_at: string | null; last_used_at: string | null;
}
export interface IntegrationPrincipal { credentialId: string; organizationId: string; tokenHash: string }

export function requireIntegrationOwner(access: AccessContext) {
  const live = getAccess(access.userId, access.organizationId);
  requirePermission(live, "company:manage");
  if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId)) throw new ApiError(403, "The company owner manages external integrations", "OWNER_REQUIRED");
}

function credential(id: string, organizationId: string) {
  const item = row<Credential>("SELECT * FROM integration_credentials WHERE id=? AND organization_id=?", id, organizationId);
  if (!item) throw new ApiError(404, "Integration credential not found", "NOT_FOUND");
  return item;
}

function safeCredential(item: Credential) {
  return { id: item.id, principalUserId: item.principal_user_id, name: item.name, prefix: item.token_prefix,
    scopes: JSON.parse(item.scopes_json) as IntegrationScope[], expiresAt: item.expires_at,
    revokedAt: item.revoked_at, createdAt: item.created_at, rotatedAt: item.rotated_at, lastUsedAt: item.last_used_at };
}

export function integrationSettings(access: AccessContext) {
  requireIntegrationOwner(access);
  return { credentials: rows<Credential>("SELECT * FROM integration_credentials WHERE organization_id=? ORDER BY created_at DESC,id DESC", access.organizationId).map(safeCredential),
    principals: rows<{ id: string; name: string }>("SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id JOIN organization_roles r ON r.id=m.role_id AND r.organization_id=m.organization_id WHERE m.organization_id=? AND m.status='active' AND r.archived_at IS NULL ORDER BY u.name,u.id", access.organizationId),
    executionEnabled: false, apiPath: "/api/integrations/v1", mcpPath: "/api/integrations/mcp" };
}

export function createIntegrationCredential(access: AccessContext, input: unknown) {
  requireIntegrationOwner(access);
  const parsed = credentialInput.parse(input), expiry = Date.parse(parsed.expiresAt);
  if (expiry <= Date.now() || expiry > Date.now() + 366 * 86400000) throw new ApiError(422, "Choose an expiry within the next 366 days", "INVALID_EXPIRY");
  const principal = getAccess(parsed.principalUserId, access.organizationId);
  for (const scope of parsed.scopes) for (const permission of scopePermissions[scope]) requirePermission(principal, permission);
  const secret = `rz_live_${newToken()}`, id = randomUUID();
  return transaction(db => {
    reserveOptionalCreation(access, "integration_credential", id);
    db.prepare("INSERT INTO integration_credentials(id,organization_id,principal_user_id,name,token_hash,token_prefix,scopes_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, access.organizationId, parsed.principalUserId, parsed.name, hashToken(secret), secret.slice(0, 16), JSON.stringify(parsed.scopes), new Date(expiry).toISOString(), now());
    audit(access.userId, access.organizationId, "integration.credential.created", id, { scopes: parsed.scopes, principalUserId: parsed.principalUserId });
    return { credential: safeCredential(credential(id, access.organizationId)), secret };
  });
}

export function revokeIntegrationCredential(access: AccessContext, id: string) {
  requireIntegrationOwner(access); credential(id, access.organizationId);
  return transaction(db => {
    db.prepare("UPDATE integration_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND organization_id=?").run(now(), id, access.organizationId);
    audit(access.userId, access.organizationId, "integration.credential.revoked", id);
    return { revoked: true };
  });
}

export function rotateIntegrationCredential(access: AccessContext, id: string) {
  requireIntegrationOwner(access);
  const existing = credential(id, access.organizationId);
  if (existing.revoked_at || existing.expires_at <= now()) throw new ApiError(409, "Create a new credential after expiry or revocation", "CREDENTIAL_INACTIVE");
  const secret = `rz_live_${newToken()}`;
  return transaction(db => {
    db.prepare("UPDATE integration_credentials SET token_hash=?,token_prefix=?,rotated_at=? WHERE id=? AND organization_id=?").run(hashToken(secret), secret.slice(0, 16), now(), id, access.organizationId);
    audit(access.userId, access.organizationId, "integration.credential.rotated", id);
    return { credential: safeCredential(credential(id, access.organizationId)), secret };
  });
}

export function authenticateIntegration(authorization?: string): IntegrationPrincipal {
  if (!authorization || !/^Bearer rz_live_[A-Za-z0-9_-]{43}$/.test(authorization)) throw new ApiError(401, "Supply a valid integration bearer credential", "INVALID_CREDENTIAL");
  const tokenHash = hashToken(authorization.slice(7));
  const item = row<Credential>("SELECT * FROM integration_credentials WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?", tokenHash, now());
  if (!item) throw new ApiError(401, "Integration credential is expired or revoked", "INVALID_CREDENTIAL");
  getAccess(item.principal_user_id, item.organization_id);
  return { credentialId: item.id, organizationId: item.organization_id, tokenHash };
}

export function integrationAccess(principal: IntegrationPrincipal, scope: IntegrationScope): AccessContext {
  const item = credential(principal.credentialId, principal.organizationId);
  if (item.revoked_at || item.expires_at <= now() || item.token_hash !== principal.tokenHash) throw new ApiError(401, "Integration credential is expired, rotated or revoked", "INVALID_CREDENTIAL");
  if (!(JSON.parse(item.scopes_json) as string[]).includes(scope)) throw new ApiError(403, "This integration credential lacks the required scope", "INSUFFICIENT_SCOPE");
  const live = getAccess(item.principal_user_id, item.organization_id);
  requirePermission(live, "company:read");
  for (const permission of scopePermissions[scope]) requirePermission(live, permission);
  return { ...live, permissions: scopePermissions[scope] };
}

export function acquireIntegrationRequest(principal: IntegrationPrincipal) {
  return transaction(db => {
    const window = Math.floor(Date.now() / 60000);
    db.prepare("DELETE FROM integration_request_leases WHERE expires_at<=?").run(now());
    const active = row<{ total: number }>("SELECT COUNT(*) AS total FROM integration_request_leases WHERE credential_id=?", principal.credentialId)!.total;
    if (active >= 4) throw new ApiError(429, "This credential has too many concurrent requests", "RATE_LIMITED");
    const changed = db.prepare("UPDATE integration_credentials SET rate_count=CASE WHEN rate_window=? THEN rate_count+1 ELSE 1 END,rate_window=?,last_used_at=? WHERE id=? AND (rate_window!=? OR rate_count<60)").run(window, window, now(), principal.credentialId, window);
    if (!changed.changes) throw new ApiError(429, "This credential permits 60 requests per minute", "RATE_LIMITED");
    const lease = randomUUID();
    db.prepare("INSERT INTO integration_request_leases(id,credential_id,expires_at) VALUES(?,?,?)").run(lease, principal.credentialId, new Date(Date.now() + 30000).toISOString());
    return () => { getDb().prepare("DELETE FROM integration_request_leases WHERE id=?").run(lease); };
  });
}

export function canonicalTerms(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTerms).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalTerms(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function paymentView(access: AccessContext, id: string) {
  const item = getPayment(access, id);
  const retired = row<{ round_id: string; amount: string; mode: "cash_backed_native_v1" }>("SELECT round_id,amount,mode FROM clearing_funded_discharges WHERE original_payment_id=? AND organization_id=?", id, access.organizationId);
  const creditRetirement=row<{noteId:string;billId:string;retiredAmount:string}>("SELECT note_id noteId,bill_id billId,original_amount retiredAmount FROM invoice_credit_retirements WHERE payment_id=? AND organization_id=?",id,access.organizationId)??null;
  return { creditRetirement, id: item.id, recipientId: item.recipient_id, reference: item.reference, amount: item.amount, maxFee: item.max_fee, status: item.status,
    deliveredAmount: item.delivered_amount, fundedDischarge: retired ? { roundId: retired.round_id, amount: retired.amount, mode: retired.mode } : null, scheduledFor: item.scheduled_for, createdAt: item.created_at, updatedAt: item.updated_at };
}
function invoiceView(access: AccessContext, id: string) {
  const item = row<{ id: string; recipient_id: string; reference: string; title: string; amount: string; max_fee: string; due_date: string | null; status: string; payment_id: string | null; created_at: string; updated_at: string }>("SELECT id,recipient_id,reference,title,amount,max_fee,due_date,status,payment_id,created_at,updated_at FROM bills WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!item) throw new ApiError(404, "Invoice not found", "NOT_FOUND");
  const terms = getBillTerms(access, id), delivered = BigInt(terms.paid), setoff = BigInt(terms.setoffAmount), funded = BigInt(terms.fundedClearingAmount), credit=BigInt(terms.acceptedCreditAmount), discharged = setoff + funded + credit, remaining = BigInt(terms.remainingLiability);
  const status = item.status === "disputed" ? "disputed" : remaining === 0n ? credit > 0n ? delivered+setoff+funded > 0n ? "settled" : "credited" : discharged > 0n ? delivered > 0n ? "settled" : "cleared" : "paid" : discharged > 0n ? "partially_settled" : delivered > 0n ? "partially_paid" : item.status;
  return { id: item.id, recipientId: item.recipient_id, reference: item.reference, title: decrypt(item.title), amount: item.amount, maxFee: item.max_fee,
    dueDate: item.due_date, status, paymentId: item.payment_id, deliveredAmount: terms.paid, setoffAmount: terms.setoffAmount, fundedClearingAmount: terms.fundedClearingAmount, acceptedCreditAmount:terms.acceptedCreditAmount, remainingLiability: terms.remainingLiability, createdAt: item.created_at, updatedAt: [item.updated_at, ...terms.installments.map(payment => payment.updated_at)].sort().at(-1)! };
}
function recipientView(access: AccessContext, id: string) {
  const item = getRecipient(access.organizationId, id);
  return { id: item.id, name: item.name, kind: item.kind, status: item.archived ? "archived" : item.preference_status, version: item.version, createdAt: item.created_at, updatedAt: item.updated_at };
}
const views = { payment: paymentView, invoice: invoiceView, recipient: recipientView };
const readScopes = { payment: "payments:read", invoice: "invoices:read", recipient: "recipients:read" } as const;
const draftScopes = { payment: "payments:draft", invoice: "invoices:draft", recipient: "recipients:draft" } as const;

export function createIntegrationDraft(principal: IntegrationPrincipal, kind: DraftKind, key: string, input: unknown) {
  const access = integrationAccess(principal, draftScopes[kind]), parsed = draftSchemas[kind].parse(input);
  idempotencyInput.parse(key);
  const termsHash = createHash("sha256").update(canonicalTerms({ kind, input: parsed })).digest("hex");
  return transaction(db => {
    const existing = row<{ id: string; terms_hash: string; kind: DraftKind; resource_id: string; created_at: string }>("SELECT * FROM integration_requests WHERE organization_id=? AND credential_id=? AND idempotency_key=?", principal.organizationId, principal.credentialId, key);
    if (existing) {
      if (existing.terms_hash !== termsHash) throw new ApiError(409, "This idempotency key is bound to different immutable terms", "IDEMPOTENCY_CONFLICT");
      return { requestId: existing.id, kind: existing.kind, resourceId: existing.resource_id, createdAt: existing.created_at, replayed: true };
    }
    let resourceId: string;
    if (kind === "payment") resourceId = createPayment(access, draftSchemas.payment.parse(parsed)).id;
    else if (kind === "invoice") resourceId = createBill(access, draftSchemas.invoice.parse(parsed)).id;
    else {
      const profile = draftSchemas.recipient.parse(parsed);
      let address: string;
      try { address = normalizeDestination(profile.primaryNetwork, profile.primaryAddress).address; }
      catch { throw new ApiError(422, "Enter a valid address for the selected network", "INVALID_DESTINATION"); }
      resourceId = randomUUID();
      db.prepare("INSERT INTO recipients(id,organization_id,name,email,kind,primary_asset,primary_network,primary_address,created_at,updated_at) VALUES(?,?,?,?,?,'USDC',?,?,?,?)")
        .run(resourceId, access.organizationId, encrypt(profile.name), profile.email ? encrypt(profile.email.toLowerCase()) : null, profile.kind, profile.primaryNetwork, address, now(), now());
      saveVersion(getRecipient(access.organizationId, resourceId), access.userId);
      audit(access.userId, access.organizationId, "recipient.integration_drafted", resourceId);
    }
    const requestId = randomUUID(), createdAt = now();
    db.prepare("INSERT INTO integration_requests(id,organization_id,credential_id,idempotency_key,terms_hash,kind,resource_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(requestId, principal.organizationId, principal.credentialId, key, termsHash, kind, resourceId, createdAt);
    audit(access.userId, access.organizationId, "integration.draft.created", requestId, { credentialId: principal.credentialId, kind, resourceId });
    enqueueIntegrationEvent(access.organizationId, "integration.draft.created", `request:${requestId}`, { resourceId, kind, status: "draft" });
    return { requestId, kind, resourceId, createdAt, replayed: false };
  });
}

export function integrationResource(principal: IntegrationPrincipal, kind: DraftKind, id: string) {
  const access = integrationAccess(principal, readScopes[kind]);
  return views[kind](access, id);
}

export function integrationResourcePage(principal: IntegrationPrincipal, kind: DraftKind, input: unknown) {
  const access = integrationAccess(principal, readScopes[kind]), query = pageInput.parse(input);
  const table = { payment: "payments", invoice: "bills", recipient: "recipients" }[kind];
  const cursor = query.after ? row<{ id: string; created_at: string }>(`SELECT id,created_at FROM ${table} WHERE id=? AND organization_id=?`, query.after, access.organizationId) : undefined;
  if (query.after && !cursor) throw new ApiError(422, "The page cursor is invalid for this company", "INVALID_CURSOR");
  const ids = cursor ? rows<{ id: string }>(`SELECT id FROM ${table} WHERE organization_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`, access.organizationId, cursor.created_at, cursor.created_at, cursor.id, query.limit + 1)
    : rows<{ id: string }>(`SELECT id FROM ${table} WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT ?`, access.organizationId, query.limit + 1);
  const items = ids.slice(0, query.limit).map(item => views[kind](access, item.id));
  return { items, nextCursor: ids.length > query.limit ? items.at(-1)!.id : null };
}

export function integrationRequestStatus(principal: IntegrationPrincipal, id: string) {
  const item = row<{ id: string; kind: DraftKind; resource_id: string; created_at: string }>("SELECT id,kind,resource_id,created_at FROM integration_requests WHERE id=? AND organization_id=? AND credential_id=?", id, principal.organizationId, principal.credentialId);
  if (!item) throw new ApiError(404, "Integration request not found", "NOT_FOUND");
  const access = integrationAccess(principal, draftScopes[item.kind]);
  const state = views[item.kind](access, item.resource_id);
  return { requestId: item.id, kind: item.kind, resourceId: item.resource_id, status: state.status, createdAt: item.created_at, updatedAt: state.updatedAt };
}

export function integrationEvidence(principal: IntegrationPrincipal, attemptId: string) {
  const access = integrationAccess(principal, "evidence:read");
  if (!row("SELECT id FROM payout_attempts WHERE id=? AND organization_id=?", attemptId, access.organizationId)) throw new ApiError(404, "Payment attempt not found", "NOT_FOUND");
  return { evidence: listPrivateEvidence(access, attemptId).map(item => ({ id: item.id, kind: item.evidence_kind, contentHash: item.content_hash, receipt: item.receipt, retained: item.retained, createdAt: item.created_at, expiresAt: item.expires_at })) };
}

export function integrationPaymentAttempts(principal: IntegrationPrincipal, paymentId: string) {
  const access = integrationAccess(principal, "payments:read");
  getPayment(access, paymentId);
  return { attempts: rows("SELECT id,route,state,created_at AS createdAt,updated_at AS updatedAt FROM payout_attempts WHERE payment_id=? AND organization_id=? ORDER BY created_at DESC,id DESC LIMIT 100", paymentId, access.organizationId) };
}

export function integrationFinancialStatus(principal: IntegrationPrincipal, kind: "funding" | "payroll", id: string) {
  const access = integrationAccess(principal, kind === "funding" ? "funding:read" : "payroll:read");
  if (kind === "payroll") {
    const run = getPayrollRun(access, id);
    return { id: run.id, reference: run.reference, status: run.status, periodStart: run.period_start, periodEnd: run.period_end, createdAt: run.created_at, updatedAt: [run.updated_at, ...run.items.flatMap(item => item.payment ? [item.payment.updated_at] : [])].sort().at(-1)! };
  }
  const item = row("SELECT id,payment_id AS paymentId,status,credited_amount AS creditedAmount,created_at AS createdAt,updated_at AS updatedAt FROM funding_legs WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!item) throw new ApiError(404, "Financial record not found", "NOT_FOUND");
  return item;
}

export function integrationAuditPage(access: AccessContext, input: unknown) {
  requireIntegrationOwner(access);
  const query = z.strictObject({ page: z.coerce.number().int().min(1).max(100000).default(1) }).parse(input);
  return { requests: rows("SELECT id,credential_id AS credentialId,kind,resource_id AS resourceId,created_at AS createdAt FROM integration_requests WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?", access.organizationId, (query.page - 1) * 25), page: query.page };
}
